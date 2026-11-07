//! Starting the desktop helper in a console session (SPEC-DESKTOP 6.2).
//!
//! The service runs in session 0, which has no screen. It copies the SYSTEM
//! token of the target session's `winlogon.exe`, makes sure the copy names
//! that session, and starts the helper with `CreateProcessAsUserW` on
//! `winsta0\default`. The helper so runs as SYSTEM in the user's session and
//! can open both the Default and the Winlogon desktops.
//!
//! The logic follows RustDesk's `GetLogonPid` and `LaunchProcessWin`
//! (`src/platform/windows.cc`, AGPL-3.0, after TigerVNC's
//! `VNCServerService`), rewritten; see NOTICE.md. Unlike RustDesk the
//! helper starts suspended, joins a Job Object that ends it when the
//! service's handle closes (a crashed service takes its helpers down), and
//! only then runs.

use super::console::{processes_in_session, Owned};
use ::windows::core::{PCWSTR, PWSTR};
use ::windows::Win32::Foundation::{HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT};
use ::windows::Win32::Security::{
    DuplicateTokenEx, SecurityImpersonation, SetTokenInformation, TokenPrimary, TokenSessionId,
    TOKEN_ADJUST_DEFAULT, TOKEN_ADJUST_SESSIONID, TOKEN_ASSIGN_PRIMARY, TOKEN_DUPLICATE,
    TOKEN_QUERY,
};
use ::windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use ::windows::Win32::System::Threading::{
    CreateProcessAsUserW, GetExitCodeProcess, OpenProcess, OpenProcessToken, ResumeThread,
    TerminateProcess, WaitForSingleObject, CREATE_NO_WINDOW, CREATE_SUSPENDED,
    CREATE_UNICODE_ENVIRONMENT, PROCESS_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION,
    STARTUPINFOW,
};
use std::time::Duration;

/// A Job Object whose processes end when its last handle closes.
pub struct Job(Owned);

// SAFETY: a job handle may be used from any thread.
unsafe impl Send for Job {}
unsafe impl Sync for Job {}

impl Job {
    pub fn new() -> Result<Job, String> {
        // SAFETY: an unnamed job; the limit structure is plain data of the
        // stated size.
        unsafe {
            let job = Owned(CreateJobObjectW(None, PCWSTR::null()).map_err(|e| e.to_string())?);
            let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
            .map_err(|e| format!("SetInformationJobObject: {e}"))?;
            Ok(Job(job))
        }
    }
}

/// A started helper process.
pub struct Process {
    handle: Owned,
    pub id: u32,
}

// SAFETY: a process handle may be used from any thread.
unsafe impl Send for Process {}
unsafe impl Sync for Process {}

impl Process {
    /// True until the process has exited.
    pub fn running(&self) -> bool {
        // SAFETY: waits zero milliseconds on our own process handle.
        unsafe { WaitForSingleObject(self.handle.0, 0) == WAIT_TIMEOUT }
    }

    /// Waits up to `timeout` for it to exit; true when it has.
    pub fn wait(&self, timeout: Duration) -> bool {
        let ms = u32::try_from(timeout.as_millis()).unwrap_or(u32::MAX);
        // SAFETY: as in `running`.
        unsafe { WaitForSingleObject(self.handle.0, ms) == WAIT_OBJECT_0 }
    }

    /// Its exit code, once it has exited.
    pub fn exit_code(&self) -> Option<u32> {
        if self.running() {
            return None;
        }
        let mut code = 0u32;
        // SAFETY: our own process handle and an out-parameter.
        unsafe { GetExitCodeProcess(self.handle.0, &mut code) }.ok()?;
        Some(code)
    }

    pub fn kill(&self) {
        // SAFETY: ends our own child; failing (it already exited) is fine.
        unsafe {
            let _ = TerminateProcess(self.handle.0, 1);
        }
    }
}

/// A primary SYSTEM token for `session`, copied from its `winlogon.exe`.
fn winlogon_token(session: u32) -> Result<Owned, String> {
    let pids = processes_in_session("winlogon.exe", session);
    let Some(&pid) = pids.first() else {
        return Err(format!("no winlogon.exe in session {session}"));
    };
    // SAFETY: handles opened here are closed when their Owned drops; the
    // session id is plain data of the stated size.
    unsafe {
        let process = Owned(
            OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
                .map_err(|e| format!("OpenProcess(winlogon {pid}): {e}"))?,
        );
        let mut token = HANDLE::default();
        OpenProcessToken(process.0, TOKEN_DUPLICATE | TOKEN_QUERY, &mut token)
            .map_err(|e| format!("OpenProcessToken(winlogon): {e}"))?;
        let token = Owned(token);
        let mut primary = HANDLE::default();
        DuplicateTokenEx(
            token.0,
            TOKEN_ASSIGN_PRIMARY
                | TOKEN_DUPLICATE
                | TOKEN_QUERY
                | TOKEN_ADJUST_DEFAULT
                | TOKEN_ADJUST_SESSIONID,
            None,
            SecurityImpersonation,
            TokenPrimary,
            &mut primary,
        )
        .map_err(|e| format!("DuplicateTokenEx: {e}"))?;
        let primary = Owned(primary);
        // Already that session's, but say so: the process must start there.
        let id = session;
        SetTokenInformation(
            primary.0,
            TokenSessionId,
            (&id as *const u32).cast(),
            std::mem::size_of::<u32>() as u32,
        )
        .map_err(|e| format!("SetTokenInformation(TokenSessionId): {e}"))?;
        Ok(primary)
    }
}

/// Starts `command_line` (program and arguments, quoted for Windows) as
/// SYSTEM in `session` on `winsta0\default`, inside `job`.
pub fn start_in_session(session: u32, command_line: &str, job: &Job) -> Result<Process, String> {
    let token = winlogon_token(session)?;
    let mut line: Vec<u16> = command_line
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let mut desktop: Vec<u16> = "winsta0\\default"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let startup = STARTUPINFOW {
        cb: std::mem::size_of::<STARTUPINFOW>() as u32,
        lpDesktop: PWSTR(desktop.as_mut_ptr()),
        ..Default::default()
    };
    let mut info = PROCESS_INFORMATION::default();
    // SAFETY: every buffer outlives the call; the command line is mutable as
    // CreateProcessAsUserW requires; the new handles are owned below.
    unsafe {
        CreateProcessAsUserW(
            Some(token.0),
            PCWSTR::null(),
            Some(PWSTR(line.as_mut_ptr())),
            None,
            None,
            false,
            CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT,
            None,
            PCWSTR::null(),
            &startup,
            &mut info,
        )
        .map_err(|e| format!("CreateProcessAsUserW in session {session}: {e}"))?;
        let thread = Owned(info.hThread);
        let process = Process {
            handle: Owned(info.hProcess),
            id: info.dwProcessId,
        };
        if let Err(e) = AssignProcessToJobObject(job.0 .0, process.handle.0) {
            process.kill();
            return Err(format!("AssignProcessToJobObject: {e}"));
        }
        if ResumeThread(thread.0) == u32::MAX {
            process.kill();
            return Err(format!(
                "ResumeThread: {}",
                ::windows::core::Error::from_thread()
            ));
        }
        Ok(process)
    }
}
