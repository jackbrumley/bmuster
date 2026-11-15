//! Starting the user files helper as the person on the screen
//! (SPEC-SESSION-FILES 4.3, SF3). One fixed program and one fixed
//! argument, `user-files`; the person comes from logind or WTS
//! ([`super::screen`]), never from the browser or the server.
//!
//! - Linux: a transient system unit `bmuster-user-files-<pid>-<n>.service`
//!   with `systemd-run --uid=<uid>`, `NoNewPrivileges=yes` and
//!   `UMask=0077`, exactly like the KMS clipboard helper; it connects back
//!   to a socket owned by the person, checked with `SO_PEERCRED`.
//! - Windows: `WTSQueryUserToken` for the console session, its filtered
//!   half when elevated, and the tray starter's checks (a person's SID,
//!   never SYSTEM); `CreateProcessAsUserW` with the person's environment,
//!   no window, and only its two pipe handles inherited.

use anyhow::Result;
use std::io::{Read, Write};

/// The one argument the helper is started with.
pub const ARGUMENT: &str = "user-files";

/// A running helper: frames go in `input`, replies come out of `output`.
/// Dropping it ends the helper.
pub struct Started {
    pub input: Box<dyn Write + Send>,
    pub output: Box<dyn Read + Send>,
    /// Keeps the helper's process (and its unit) until dropped.
    pub process: Box<dyn Send>,
}

/// `systemd-run`'s arguments for the helper: as `uid`, the fixed program
/// and argument, and the connect-back socket.
#[cfg(target_os = "linux")]
pub fn unit_arguments(
    unit: &str,
    uid: u32,
    program: &std::path::Path,
    socket: &std::path::Path,
) -> Vec<std::ffi::OsString> {
    crate::wayland::capture::unit_arguments(unit, uid, program, ARGUMENT, socket)
}

/// Starts the helper as `uid`.
#[cfg(target_os = "linux")]
pub fn start(uid: u32) -> Result<Started> {
    use crate::exec::connect::{self, ConnectSocket, Folder, Peer};
    use crate::exec::unit::Manager;
    use anyhow::{bail, Context as _};
    if uid < 1000 || uid == 65534 {
        bail!("The user files helper runs only as a person, not uid {uid}");
    }
    let program = crate::wayland::helper_program()?;
    let unit = format!(
        "bmuster-user-files-{}-{}.service",
        std::process::id(),
        crate::wayland::next_id()
    );
    let socket = ConnectSocket::create(&Folder::system(), uid)?;
    let mut command = std::process::Command::new("systemd-run");
    command.args(unit_arguments(&unit, uid, &program, socket.path()));
    let connected = connect::start(
        socket,
        &Peer::new(uid, &unit, Manager::System),
        command,
        "user-files",
        &std::sync::atomic::AtomicBool::new(false),
    )
    .context("Could not start the user files helper")?;
    let output = connected.stream.try_clone()?;
    Ok(Started {
        input: Box::new(connected.stream),
        output: Box::new(output),
        process: Box::new(Unit {
            name: unit,
            systemd_run: connected.systemd_run,
        }),
    })
}

/// A started unit: stopped, and `systemd-run` reaped, when dropped.
#[cfg(target_os = "linux")]
struct Unit {
    name: String,
    systemd_run: std::process::Child,
}

#[cfg(target_os = "linux")]
impl Drop for Unit {
    fn drop(&mut self) {
        crate::exec::unit::stop_units(crate::exec::unit::Manager::System, &[self.name.as_str()]);
        let _ = self.systemd_run.kill();
        let _ = self.systemd_run.wait();
    }
}

/// The helper's command line on Windows: the program, quoted, and the one argument.
#[cfg(any(windows, test))]
pub fn command_line(program: &str) -> String {
    format!(
        "{} {ARGUMENT}",
        bmuster_desktop::winsession::command_line::quote(program)
    )
}

/// Starts the helper in console session `session` as its person.
#[cfg(windows)]
pub fn start(session: u32) -> Result<Started> {
    win::start(session)
}

#[cfg(windows)]
mod win {
    use super::*;
    use crate::tray::windows_starter::{installed_tray_program, person_token, Environment};
    use anyhow::Context as _;
    use std::ffi::{c_void, OsStr};
    use std::fs::File;
    use std::os::windows::ffi::OsStrExt as _;
    use std::os::windows::io::{FromRawHandle as _, OwnedHandle};
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::{
        CloseHandle, SetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT,
    };
    use windows::Win32::Security::SECURITY_ATTRIBUTES;
    use windows::Win32::System::Pipes::CreatePipe;
    use windows::Win32::System::Threading::{
        CreateProcessAsUserW, DeleteProcThreadAttributeList, InitializeProcThreadAttributeList,
        TerminateProcess, UpdateProcThreadAttribute, CREATE_NO_WINDOW, CREATE_UNICODE_ENVIRONMENT,
        EXTENDED_STARTUPINFO_PRESENT, LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION,
        PROC_THREAD_ATTRIBUTE_HANDLE_LIST, STARTF_USESTDHANDLES, STARTUPINFOEXW,
    };

    /// The helper process: ended when dropped.
    struct Process(HANDLE);

    // SAFETY: a process handle may be used from any thread.
    unsafe impl Send for Process {}

    impl Drop for Process {
        fn drop(&mut self) {
            // SAFETY: our handle, ended and closed once.
            unsafe {
                let _ = TerminateProcess(self.0, 0);
                let _ = CloseHandle(self.0);
            }
        }
    }

    fn wide(text: &OsStr) -> Vec<u16> {
        text.encode_wide().chain(Some(0)).collect()
    }

    /// An anonymous pipe; the end `child_reads` names is inheritable.
    fn pipe(child_reads: bool) -> Result<(HANDLE, HANDLE)> {
        let security = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: std::ptr::null_mut(),
            bInheritHandle: true.into(),
        };
        let (mut read, mut write) = (HANDLE::default(), HANDLE::default());
        // SAFETY: out-parameters; both handles are owned by the caller.
        unsafe {
            CreatePipe(&mut read, &mut write, Some(&security), 0).context("CreatePipe")?;
            // Only the child's end is inherited.
            let ours = if child_reads { write } else { read };
            SetHandleInformation(ours, HANDLE_FLAG_INHERIT.0, Default::default())
                .context("SetHandleInformation")?;
        }
        Ok((read, write))
    }

    pub fn start(session: u32) -> Result<Started> {
        let program = installed_tray_program()?;
        let token = person_token(session).map_err(anyhow::Error::msg)?;
        let environment = Environment::of(&token).map_err(anyhow::Error::msg)?;
        let (child_in, our_in) = pipe(true)?;
        let (our_out, child_out) = pipe(false)?;
        // SAFETY: the handles were just made and are owned here.
        let (our_in, our_out, child_in, child_out) = unsafe {
            (
                OwnedHandle::from_raw_handle(our_in.0),
                OwnedHandle::from_raw_handle(our_out.0),
                OwnedHandle::from_raw_handle(child_in.0),
                OwnedHandle::from_raw_handle(child_out.0),
            )
        };
        let application = wide(program.as_os_str());
        let mut line: Vec<u16> = command_line(&program.to_string_lossy())
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let folder = wide(program.parent().unwrap_or(&program).as_os_str());
        // The person's interactive desktop, where their clipboard is.
        let mut desktop = wide(OsStr::new("winsta0\\default"));
        let inherited = [
            HANDLE(std::os::windows::io::AsRawHandle::as_raw_handle(&child_in)),
            HANDLE(std::os::windows::io::AsRawHandle::as_raw_handle(&child_out)),
        ];
        let mut size = 0usize;
        // SAFETY: the first call reports the list's size; the list lives in
        // `buffer` until it is deleted below; `inherited` outlives the call
        // that uses it.
        let info = unsafe {
            let _ = InitializeProcThreadAttributeList(None, 1, None, &mut size);
            let mut buffer = vec![0u8; size];
            let list = LPPROC_THREAD_ATTRIBUTE_LIST(buffer.as_mut_ptr().cast());
            InitializeProcThreadAttributeList(Some(list), 1, None, &mut size)
                .context("InitializeProcThreadAttributeList")?;
            UpdateProcThreadAttribute(
                list,
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                Some(inherited.as_ptr().cast::<c_void>()),
                std::mem::size_of_val(&inherited),
                None,
                None,
            )
            .context("UpdateProcThreadAttribute")?;
            let mut startup = STARTUPINFOEXW::default();
            startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
            startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
            startup.StartupInfo.lpDesktop = PWSTR(desktop.as_mut_ptr());
            startup.StartupInfo.hStdInput = inherited[0];
            startup.StartupInfo.hStdOutput = inherited[1];
            startup.StartupInfo.hStdError = inherited[1];
            startup.lpAttributeList = list;
            let mut info = PROCESS_INFORMATION::default();
            let created = CreateProcessAsUserW(
                Some(token.0),
                PCWSTR(application.as_ptr()),
                Some(PWSTR(line.as_mut_ptr())),
                None,
                None,
                true,
                CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT,
                Some(environment.0.cast_const()),
                PCWSTR(folder.as_ptr()),
                &startup.StartupInfo,
                &mut info,
            );
            DeleteProcThreadAttributeList(list);
            drop(buffer);
            created.context("CreateProcessAsUserW")?;
            let _ = CloseHandle(info.hThread);
            info
        };
        // The child holds its own ends now.
        drop(child_in);
        drop(child_out);
        Ok(Started {
            input: Box::new(File::from(our_in)),
            output: Box::new(File::from(our_out)),
            process: Box::new(Process(info.hProcess)),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// SF3: the fixed program, the one argument, as the person's uid.
    #[test]
    fn sf3_the_helper_runs_as_the_person_with_fixed_arguments() {
        assert_eq!(
            command_line(r"C:\Program Files\BMuster\bmuster-tray-0.5.0.exe"),
            r#""C:\Program Files\BMuster\bmuster-tray-0.5.0.exe" user-files"#
        );
        #[cfg(target_os = "linux")]
        {
            let args: Vec<String> = unit_arguments(
                "bmuster-user-files-1-1.service",
                1000,
                std::path::Path::new("/opt/bmuster/current/bmuster-agent"),
                std::path::Path::new("/run/bmuster/connect/x.sock"),
            )
            .into_iter()
            .map(|arg| arg.into_string().unwrap())
            .collect();
            for expected in [
                "--uid=1000",
                "--unit=bmuster-user-files-1-1.service",
                "--property=NoNewPrivileges=yes",
                "--property=UMask=0077",
            ] {
                assert!(
                    args.iter().any(|arg| arg == expected),
                    "{expected}: {args:?}"
                );
            }
            let program = args.iter().position(|arg| arg == "--").unwrap() + 1;
            assert_eq!(
                &args[program..],
                [
                    "/opt/bmuster/current/bmuster-agent",
                    "user-files",
                    "/run/bmuster/connect/x.sock"
                ]
            );
            // Nobody signed in or a system account: no helper starts.
            for refused in [0, 999, 65534] {
                assert!(start(refused).is_err(), "{refused}");
            }
        }
    }
}
