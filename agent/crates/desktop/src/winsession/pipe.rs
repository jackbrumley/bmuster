//! The named pipes between the service and its desktop helper (SPEC-DESKTOP
//! 6.2). Two one-way pipes, `<name>-in` (service to helper) and
//! `<name>-out` (helper to service): Windows serialises synchronous I/O on
//! one pipe handle, so a read waiting on a duplex pipe would hold up every
//! write.
//!
//! Each pipe allows SYSTEM only (`D:P(A;;GA;;;SY)`), refuses remote
//! clients, has one instance, and is created with
//! `FILE_FLAG_FIRST_PIPE_INSTANCE`, so nobody can have made it first. Each
//! side checks the other's process id: the service the helper it started,
//! the helper the service named on its command line. The client opens the
//! pipes at identification level, so the service cannot act as it.

use super::console::Owned;
use ::windows::core::PCWSTR;
use ::windows::Win32::Foundation::{
    LocalFree, ERROR_FILE_NOT_FOUND, ERROR_PIPE_BUSY, ERROR_PIPE_CONNECTED, ERROR_PIPE_LISTENING,
    GENERIC_READ, GENERIC_WRITE, HANDLE, HLOCAL, INVALID_HANDLE_VALUE,
};
use ::windows::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use ::windows::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
use ::windows::Win32::Storage::FileSystem::{
    CreateFileW, FILE_FLAGS_AND_ATTRIBUTES, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_SHARE_NONE,
    OPEN_EXISTING, PIPE_ACCESS_DUPLEX, SECURITY_IDENTIFICATION, SECURITY_SQOS_PRESENT,
};
use ::windows::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, GetNamedPipeClientProcessId, GetNamedPipeServerProcessId,
    SetNamedPipeHandleState, PIPE_NOWAIT, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS,
    PIPE_TYPE_BYTE, PIPE_WAIT,
};
use std::collections::hash_map::RandomState;
use std::fs::File;
use std::hash::{BuildHasher as _, Hasher as _};
use std::os::windows::io::{FromRawHandle as _, RawHandle};
use std::time::{Duration, Instant};

/// Only SYSTEM may open the pipes.
pub const SYSTEM_ONLY: &str = "D:P(A;;GA;;;SY)";
const BUFFER: u32 = 64 * 1024;
const POLL: Duration = Duration::from_millis(50);

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// A fresh, unguessable pipe name.
pub fn fresh_name() -> String {
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_u32(std::process::id());
    hasher.write_u128(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
    );
    let first = hasher.finish();
    let second = RandomState::new().build_hasher().finish();
    format!(r"\\.\pipe\bmuster-desktop-{first:016x}{second:016x}")
}

fn to_helper(name: &str) -> String {
    format!("{name}-in")
}

fn from_helper(name: &str) -> String {
    format!("{name}-out")
}

/// A handle as a `File`, which reads and writes with ReadFile/WriteFile
/// and treats a closed pipe as the end.
fn into_file(handle: Owned) -> File {
    let raw = handle.0 .0 as RawHandle;
    std::mem::forget(handle);
    // SAFETY: the handle is open and now owned by the File alone.
    unsafe { File::from_raw_handle(raw) }
}

/// Each server end is duplex even though it is used one way: switching a
/// pipe to blocking mode needs write access to its attributes, which an
/// inbound-only handle lacks. The helper opens each end one way only.
fn create(name: &str, sddl: &str) -> Result<Owned, String> {
    let mut descriptor = PSECURITY_DESCRIPTOR::default();
    let sddl = wide(sddl);
    // SAFETY: the descriptor is allocated by Windows and freed below, after
    // CreateNamedPipeW copied it.
    unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            PCWSTR(sddl.as_ptr()),
            SDDL_REVISION_1,
            &mut descriptor,
            None,
        )
        .map_err(|e| format!("the pipe's security descriptor: {e}"))?;
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.0,
            bInheritHandle: false.into(),
        };
        let wide_name = wide(name);
        let handle = CreateNamedPipeW(
            PCWSTR(wide_name.as_ptr()),
            PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_NOWAIT | PIPE_REJECT_REMOTE_CLIENTS,
            1,
            BUFFER,
            BUFFER,
            0,
            Some(&attributes),
        );
        let _ = LocalFree(Some(HLOCAL(descriptor.0)));
        if handle == INVALID_HANDLE_VALUE || handle.is_invalid() {
            return Err(format!(
                "could not create the pipe {name}: {}",
                ::windows::core::Error::from_thread()
            ));
        }
        Ok(Owned(handle))
    }
}

/// The service's end before the helper has connected.
pub struct Listener {
    name: String,
    to_helper: Owned,
    from_helper: Owned,
}

/// The service's end once the helper is connected.
pub struct ServiceEnd {
    /// Messages to the helper.
    pub writer: File,
    /// Messages from the helper.
    pub reader: File,
}

impl Listener {
    /// Creates both pipes under a fresh name, with `sddl` as their DACL
    /// ([`SYSTEM_ONLY`] outside tests).
    pub fn create(sddl: &str) -> Result<Listener, String> {
        let name = fresh_name();
        let to = create(&to_helper(&name), sddl)?;
        let from = create(&from_helper(&name), sddl)?;
        Ok(Listener {
            name,
            to_helper: to,
            from_helper: from,
        })
    }

    /// The name to give the helper (without `-in` or `-out`).
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Waits until the helper has opened both pipes, for at most `timeout`
    /// and while `alive` says the helper still runs. With `expected_client`,
    /// a client with another process id is refused.
    pub fn accept(
        self,
        expected_client: Option<u32>,
        timeout: Duration,
        alive: impl Fn() -> bool,
    ) -> Result<ServiceEnd, String> {
        let deadline = Instant::now() + timeout;
        for pipe in [&self.to_helper, &self.from_helper] {
            wait_for_client(pipe.0, deadline, &alive)?;
            if let Some(expected) = expected_client {
                let mut client = 0u32;
                // SAFETY: a connected pipe handle and an out-parameter.
                unsafe { GetNamedPipeClientProcessId(pipe.0, &mut client) }
                    .map_err(|e| format!("GetNamedPipeClientProcessId: {e}"))?;
                if client != expected {
                    return Err(format!(
                        "process {client} opened the helper's pipe, not the helper ({expected})"
                    ));
                }
            }
            let blocking = PIPE_READMODE_BYTE | PIPE_WAIT;
            // SAFETY: switches our own pipe handle to blocking reads and writes.
            unsafe { SetNamedPipeHandleState(pipe.0, Some(&blocking), None, None) }
                .map_err(|e| format!("SetNamedPipeHandleState: {e}"))?;
        }
        Ok(ServiceEnd {
            writer: into_file(self.to_helper),
            reader: into_file(self.from_helper),
        })
    }
}

fn wait_for_client(
    pipe: HANDLE,
    deadline: Instant,
    alive: &impl Fn() -> bool,
) -> Result<(), String> {
    loop {
        // SAFETY: a non-blocking pipe: ConnectNamedPipe returns at once.
        match unsafe { ConnectNamedPipe(pipe, None) } {
            Err(e) if e.code() == ERROR_PIPE_CONNECTED.to_hresult() => return Ok(()),
            Ok(()) => {}
            Err(e) if e.code() == ERROR_PIPE_LISTENING.to_hresult() => {}
            Err(e) => return Err(format!("ConnectNamedPipe: {e}")),
        }
        if !alive() {
            return Err("the helper exited before it opened its pipe".into());
        }
        if Instant::now() >= deadline {
            return Err("the helper did not open its pipe in time".into());
        }
        std::thread::sleep(POLL);
    }
}

/// The helper's end.
pub struct HelperEnd {
    /// Messages from the service.
    pub reader: File,
    /// Messages to the service.
    pub writer: File,
}

fn open(name: &str, access: u32, deadline: Instant) -> Result<Owned, String> {
    let wide_name = wide(name);
    loop {
        // SAFETY: opens an existing pipe; the handle is owned by the result.
        let opened = unsafe {
            CreateFileW(
                PCWSTR(wide_name.as_ptr()),
                access,
                FILE_SHARE_NONE,
                None,
                OPEN_EXISTING,
                FILE_FLAGS_AND_ATTRIBUTES(SECURITY_SQOS_PRESENT.0 | SECURITY_IDENTIFICATION.0),
                None,
            )
        };
        match opened {
            Ok(handle) => return Ok(Owned(handle)),
            Err(e)
                if (e.code() == ERROR_FILE_NOT_FOUND.to_hresult()
                    || e.code() == ERROR_PIPE_BUSY.to_hresult())
                    && Instant::now() < deadline =>
            {
                std::thread::sleep(POLL);
            }
            Err(e) => return Err(format!("could not open {name}: {e}")),
        }
    }
}

/// Opens the service's pipes named `name`. With `expected_server`, a pipe
/// served by another process is refused.
pub fn connect(
    name: &str,
    expected_server: Option<u32>,
    timeout: Duration,
) -> Result<HelperEnd, String> {
    let deadline = Instant::now() + timeout;
    let reader = open(&to_helper(name), GENERIC_READ.0, deadline)?;
    let writer = open(&from_helper(name), GENERIC_WRITE.0, deadline)?;
    if let Some(expected) = expected_server {
        for pipe in [&reader, &writer] {
            let mut server = 0u32;
            // SAFETY: a connected pipe handle and an out-parameter.
            unsafe { GetNamedPipeServerProcessId(pipe.0, &mut server) }
                .map_err(|e| format!("GetNamedPipeServerProcessId: {e}"))?;
            if server != expected {
                return Err(format!(
                    "the pipe is served by process {server}, not the agent ({expected})"
                ));
            }
        }
    }
    Ok(HelperEnd {
        reader: into_file(reader),
        writer: into_file(writer),
    })
}

#[cfg(test)]
mod tests {
    use super::super::handoff::{read_message, write_message, FromHelper, ToHelper};
    use super::*;

    /// Under Wine or on Windows: both pipes carry framed messages each way,
    /// and the name cannot be taken twice. (The test runs as a normal user,
    /// so its pipes allow their owner rather than SYSTEM.)
    #[test]
    fn pipe_pair_carries_handoff_messages_both_ways() {
        let listener = Listener::create("D:P(A;;GA;;;OW)").unwrap();
        let name = listener.name().to_string();
        assert!(
            create(&to_helper(&name), "D:P(A;;GA;;;OW)").is_err(),
            "a second first instance is refused"
        );
        let me = std::process::id();
        let helper = std::thread::spawn(move || {
            let mut end = connect(&name, Some(me), Duration::from_secs(5)).unwrap();
            let start: Option<ToHelper> = read_message(&mut end.reader).unwrap();
            assert_eq!(start, Some(ToHelper::Quit));
            write_message(&mut end.writer, &FromHelper::SecureAttention).unwrap();
        });
        let mut service = listener
            .accept(Some(me), Duration::from_secs(5), || true)
            .unwrap();
        write_message(&mut service.writer, &ToHelper::Quit).unwrap();
        let got: Option<FromHelper> = read_message(&mut service.reader).unwrap();
        assert_eq!(got, Some(FromHelper::SecureAttention));
        helper.join().unwrap();
        // The helper closed its end: a clean end of messages.
        let after: Option<FromHelper> = read_message(&mut service.reader).unwrap();
        assert_eq!(after, None);
    }

    #[test]
    fn pipe_accept_gives_up_when_the_helper_is_gone() {
        let listener = Listener::create("D:P(A;;GA;;;OW)").unwrap();
        let result = listener.accept(None, Duration::from_secs(5), || false);
        assert!(result.is_err());
    }
}
