//! Ending everything a session started, not just its first process.
//!
//! Unix: each session's first process leads its own session (`setsid`), so
//! everything it starts shares that session id unless it leaves on purpose
//! (`setsid`, a daemon). Ending it sends SIGHUP (what closing a terminal
//! sends), waits briefly, then SIGKILLs whatever is left. On Linux the
//! session's processes are found in /proc, so background jobs in their own
//! process groups go too; elsewhere the leader's process group is signalled.
//!
//! Windows: a Job Object that kills every process in it when it is
//! terminated or its last handle closes.

#[cfg(unix)]
use std::time::{Duration, Instant};

/// How long processes get to exit after SIGHUP before SIGKILL.
#[cfg(unix)]
const GRACE: Duration = Duration::from_millis(1500);

/// Ends every process in session `sid` (the session leader's pid).
#[cfg(unix)]
pub fn end_session(sid: libc::pid_t) {
    if sid <= 1 {
        return;
    }
    signal_all(sid, libc::SIGHUP);
    signal_all(sid, libc::SIGCONT);
    let until = Instant::now() + GRACE;
    while Instant::now() < until {
        if members(sid).is_empty() {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    signal_all(sid, libc::SIGKILL);
}

#[cfg(unix)]
fn signal_all(sid: libc::pid_t, signal: libc::c_int) {
    // SAFETY: plain system calls on process ids; a stale id fails with ESRCH.
    unsafe {
        libc::killpg(sid, signal);
    }
    for pid in members(sid) {
        unsafe {
            libc::kill(pid, signal);
        }
    }
}

/// Live (not zombie) processes in session `sid`, from /proc.
#[cfg(target_os = "linux")]
fn members(sid: libc::pid_t) -> Vec<libc::pid_t> {
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return Vec::new();
    };
    entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| entry.file_name().to_str()?.parse::<libc::pid_t>().ok())
        .filter(|pid| {
            std::fs::read_to_string(format!("/proc/{pid}/stat"))
                .ok()
                .and_then(|stat| session_of(&stat))
                == Some((sid, false))
        })
        .collect()
}

/// (session id, is a zombie) from a /proc/<pid>/stat line.
#[cfg(target_os = "linux")]
fn session_of(stat: &str) -> Option<(libc::pid_t, bool)> {
    // The command name can hold spaces and brackets; fields follow the last ')'.
    let rest = &stat[stat.rfind(')')? + 1..];
    let mut fields = rest.split_whitespace();
    let state = fields.next()?;
    let session = fields.nth(2)?.parse().ok()?;
    Some((session, state == "Z" || state == "X"))
}

/// Elsewhere only the leader's process group can be found.
#[cfg(all(unix, not(target_os = "linux")))]
fn members(sid: libc::pid_t) -> Vec<libc::pid_t> {
    // SAFETY: signal 0 only checks whether the group exists.
    if unsafe { libc::killpg(sid, 0) } == 0 {
        vec![-sid]
    } else {
        Vec::new()
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[test]
    fn stat_lines_are_read_after_the_command_name() {
        let line = "4242 (my (odd) cmd) S 1 4242 4242 34816 4242 4194560";
        assert_eq!(session_of(line), Some((4242, false)));
        let zombie = "77 (sleep) Z 1 77 4242 0 -1 4227084";
        assert_eq!(session_of(zombie), Some((4242, true)));
        assert_eq!(session_of("garbage"), None);
    }
}

#[cfg(windows)]
use anyhow::{bail, Result};
#[cfg(windows)]
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
#[cfg(windows)]
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, TerminateJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

/// A Job Object that kills its processes when terminated or dropped.
#[cfg(windows)]
pub struct Job(HANDLE);

// SAFETY: a job handle may be used from any thread.
#[cfg(windows)]
unsafe impl Send for Job {}
#[cfg(windows)]
unsafe impl Sync for Job {}

#[cfg(windows)]
impl Job {
    pub fn new() -> Result<Self> {
        // SAFETY: null attributes and name make an unnamed job with default security.
        let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if handle.is_null() {
            bail!(
                "could not create a job object: {}",
                std::io::Error::last_os_error()
            );
        }
        let job = Job(handle);
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: `limits` is the structure this information class expects.
        let ok = unsafe {
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                std::ptr::from_ref(&limits).cast(),
                u32::try_from(std::mem::size_of_val(&limits)).unwrap_or(u32::MAX),
            )
        };
        if ok == 0 {
            bail!(
                "could not set the job's limits: {}",
                std::io::Error::last_os_error()
            );
        }
        Ok(job)
    }

    /// Puts a process (and so everything it starts) in the job.
    pub fn assign(&self, process: HANDLE) -> Result<()> {
        // SAFETY: both handles are open.
        if unsafe { AssignProcessToJobObject(self.0, process) } == 0 {
            bail!(
                "could not add the process to its job: {}",
                std::io::Error::last_os_error()
            );
        }
        Ok(())
    }

    /// Kills every process in the job.
    pub fn terminate(&self) {
        // SAFETY: the handle is open until drop.
        unsafe {
            TerminateJobObject(self.0, 1);
        }
    }
}

#[cfg(windows)]
impl Drop for Job {
    fn drop(&mut self) {
        // SAFETY: closing the last handle kills what is left (KILL_ON_JOB_CLOSE).
        unsafe {
            CloseHandle(self.0);
        }
    }
}
