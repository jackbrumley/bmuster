//! Pseudo-terminals on Windows: ConPTY (`CreatePseudoConsole`), with the
//! shell started suspended, put in a Job Object, then resumed, so nothing it
//! starts escapes the session.
//!
//! The ConPTY set-up follows portable-pty's `src/win/psuedocon.rs` (MIT,
//! Copyright (c) 2018 Wez Furlong), rewritten on `windows-sys`.
//!
//! `ClosePseudoConsole` can block until its output pipe is drained (the
//! reason MeshCentral hosts ConPTY in a child process), so it runs on its own
//! thread while the session's reader keeps reading to the end.

use super::spawn::Launch;
use super::tree::Job;
use super::PtySize;
use anyhow::{bail, Result};
use std::ffi::{OsStr, OsString};
use std::fs::File;
use std::io;
use std::os::windows::ffi::OsStrExt as _;
use std::os::windows::io::FromRawHandle as _;
use std::sync::Mutex;
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Console::{
    ClosePseudoConsole, CreatePseudoConsole, ResizePseudoConsole, COORD, HPCON,
};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess,
    InitializeProcThreadAttributeList, ResumeThread, UpdateProcThreadAttribute,
    WaitForSingleObject, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT,
    EXTENDED_STARTUPINFO_PRESENT, INFINITE, PROCESS_INFORMATION,
    PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, STARTF_USESTDHANDLES, STARTUPINFOEXW,
};

/// The pseudo console, its shell's job, and the shell's process handle.
pub struct Pty {
    /// `None` once closed.
    console: Mutex<Option<HPCON>>,
    job: Job,
}

// SAFETY: HPCON and job handles may be used from any thread; the console is
// behind a mutex so it is closed once.
unsafe impl Send for Pty {}
unsafe impl Sync for Pty {}

pub struct Spawned {
    pub pty: Pty,
    pub process: ShellProcess,
    pub reader: File,
    pub writer: File,
}

/// The shell process, for the thread that waits for it to end.
pub struct ShellProcess(HANDLE);

// SAFETY: a process handle may be waited on from any thread.
unsafe impl Send for ShellProcess {}

impl ShellProcess {
    pub fn wait(&mut self) -> Result<i32> {
        // SAFETY: the handle is open until drop.
        unsafe {
            WaitForSingleObject(self.0, INFINITE);
        }
        let mut code: u32 = 0;
        // SAFETY: as above; `code` is written on success.
        if unsafe { GetExitCodeProcess(self.0, &mut code) } == 0 {
            bail!(
                "could not read the shell's exit code: {}",
                io::Error::last_os_error()
            );
        }
        Ok(i32::from_ne_bytes(code.to_ne_bytes()))
    }
}

impl Drop for ShellProcess {
    fn drop(&mut self) {
        // SAFETY: we own the handle.
        unsafe {
            CloseHandle(self.0);
        }
    }
}

/// A handle closed on drop, for the set-up's error paths.
struct Owned(HANDLE);

impl Owned {
    fn take(mut self) -> HANDLE {
        std::mem::replace(&mut self.0, INVALID_HANDLE_VALUE)
    }
}

impl Drop for Owned {
    fn drop(&mut self) {
        if self.0 != INVALID_HANDLE_VALUE && !self.0.is_null() {
            // SAFETY: we own the handle.
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

fn coord(size: PtySize) -> COORD {
    COORD {
        X: i16::try_from(size.cols).unwrap_or(i16::MAX),
        Y: i16::try_from(size.rows).unwrap_or(i16::MAX),
    }
}

fn pipe() -> Result<(Owned, Owned)> {
    let mut read: HANDLE = INVALID_HANDLE_VALUE;
    let mut write: HANDLE = INVALID_HANDLE_VALUE;
    // SAFETY: CreatePipe writes two handles; null attributes are not inherited.
    if unsafe { CreatePipe(&mut read, &mut write, std::ptr::null(), 0) } == 0 {
        bail!("could not create a pipe: {}", io::Error::last_os_error());
    }
    Ok((Owned(read), Owned(write)))
}

fn wide(text: &OsStr) -> Vec<u16> {
    text.encode_wide().chain(std::iter::once(0)).collect()
}

/// `"C:\...\program.exe" arg arg`: the program path quoted, the fixed
/// arguments (which hold no quotes or spaces) as they are.
fn command_line(launch: &Launch) -> Vec<u16> {
    let mut line = OsString::from("\"");
    line.push(launch.program.path.as_os_str());
    line.push("\"");
    for arg in &launch.program.args {
        line.push(" ");
        line.push(arg);
    }
    wide(&line)
}

/// `NAME=value\0…\0\0`, sorted by name ignoring case as Windows expects.
fn environment_block(env: &[(OsString, OsString)]) -> Vec<u16> {
    let mut sorted: Vec<&(OsString, OsString)> = env.iter().collect();
    sorted.sort_by_key(|(name, _)| name.to_string_lossy().to_uppercase());
    let mut block = Vec::new();
    for (name, value) in sorted {
        block.extend(name.encode_wide());
        block.push(u16::from(b'='));
        block.extend(value.encode_wide());
        block.push(0);
    }
    block.push(0);
    block
}

impl Pty {
    pub fn spawn(launch: &Launch, size: PtySize) -> Result<Spawned> {
        let (input_read, input_write) = pipe()?;
        let (output_read, output_write) = pipe()?;
        let mut console: HPCON = 0;
        // SAFETY: the pipe handles are open; ConPTY duplicates the ones it keeps.
        let result = unsafe {
            CreatePseudoConsole(coord(size), input_read.0, output_write.0, 0, &mut console)
        };
        if result != 0 {
            bail!("could not create a pseudo console (HRESULT {result:#x})");
        }
        // Our copies of the console's ends are no longer needed.
        drop(input_read);
        drop(output_write);
        let pty = Pty {
            console: Mutex::new(Some(console)),
            job: Job::new()?,
        };

        let mut list_size: usize = 0;
        // SAFETY: the first call only reports the size needed.
        unsafe {
            InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut list_size);
        }
        let mut list = vec![0u8; list_size];
        let attributes = list.as_mut_ptr().cast();
        // SAFETY: `list` is `list_size` bytes, as asked for.
        if unsafe { InitializeProcThreadAttributeList(attributes, 1, 0, &mut list_size) } == 0 {
            bail!(
                "could not prepare the shell's attributes: {}",
                io::Error::last_os_error()
            );
        }
        // SAFETY: the attribute's value is the HPCON itself, passed by value.
        let updated = unsafe {
            UpdateProcThreadAttribute(
                attributes,
                0,
                PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
                console as *const std::ffi::c_void,
                std::mem::size_of::<HPCON>(),
                std::ptr::null_mut(),
                std::ptr::null(),
            )
        };
        if updated == 0 {
            // SAFETY: initialised above.
            unsafe { DeleteProcThreadAttributeList(attributes) };
            bail!(
                "could not attach the pseudo console: {}",
                io::Error::last_os_error()
            );
        }

        let mut startup = STARTUPINFOEXW::default();
        startup.StartupInfo.cb = u32::try_from(std::mem::size_of::<STARTUPINFOEXW>()).unwrap_or(0);
        // No inherited standard handles: the console is the shell's only I/O.
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = INVALID_HANDLE_VALUE;
        startup.StartupInfo.hStdOutput = INVALID_HANDLE_VALUE;
        startup.StartupInfo.hStdError = INVALID_HANDLE_VALUE;
        startup.lpAttributeList = attributes;

        let mut line = command_line(launch);
        let environment = environment_block(&launch.env);
        let cwd = wide(launch.cwd.as_os_str());
        let mut info = PROCESS_INFORMATION::default();
        // SAFETY: every buffer outlives the call; the command line is mutable
        // as CreateProcessW requires.
        let created = unsafe {
            CreateProcessW(
                std::ptr::null(),
                line.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                0,
                EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED,
                environment.as_ptr().cast(),
                cwd.as_ptr(),
                &startup.StartupInfo,
                &mut info,
            )
        };
        let created_error = io::Error::last_os_error();
        // SAFETY: initialised above and no longer needed.
        unsafe { DeleteProcThreadAttributeList(attributes) };
        drop(list);
        if created == 0 {
            bail!(
                "could not start {}: {created_error}",
                launch.program.path.display()
            );
        }
        let process = ShellProcess(info.hProcess);
        let thread = Owned(info.hThread);
        if let Err(e) = pty.job.assign(process.0) {
            pty.job.terminate();
            // SAFETY: the suspended process is ours to end.
            unsafe {
                windows_sys::Win32::System::Threading::TerminateProcess(process.0, 1);
            }
            return Err(e);
        }
        // SAFETY: the thread handle is open; the shell starts now, inside its job.
        unsafe {
            ResumeThread(thread.0);
        }
        drop(thread);

        // SAFETY: CreatePipe gave us these handles and nothing else owns them.
        let reader = unsafe { File::from_raw_handle(output_read.take()) };
        let writer = unsafe { File::from_raw_handle(input_write.take()) };
        Ok(Spawned {
            pty,
            process,
            reader,
            writer,
        })
    }

    pub fn resize(&self, size: PtySize) -> Result<()> {
        let console = self.console.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(console) = *console {
            // SAFETY: the console is open while it is in the mutex.
            let result = unsafe { ResizePseudoConsole(console, coord(size)) };
            if result != 0 {
                bail!("could not resize the console (HRESULT {result:#x})");
            }
        }
        Ok(())
    }

    /// Ends the shell and everything it started, then closes the console on
    /// its own thread (see the module notes).
    pub fn end(&self) {
        self.job.terminate();
        let console = self
            .console
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take();
        if let Some(console) = console {
            let closing = std::thread::Builder::new()
                .name("close-console".into())
                .spawn(move || {
                    // SAFETY: taken out of the mutex, so closed exactly once.
                    unsafe { ClosePseudoConsole(console) };
                });
            if let Err(e) = closing {
                log::warn!("Could not close the pseudo console: {e}");
            }
        }
    }
}

impl Drop for Pty {
    fn drop(&mut self) {
        self.end();
    }
}

/// Reading a closed ConPTY output pipe ends with "broken pipe".
pub fn is_hangup(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::BrokenPipe
}
