//! What the running agent knows about its connection, shared by the check-in
//! loop, the live socket and the local page.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, SystemTime};

/// How the agent was started, which decides how it restarts and uninstalls.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunMode {
    /// By systemd or the Windows service manager.
    Service,
    /// By hand (`bmuster-agent run` in a terminal), usually for development.
    Foreground,
}

#[derive(Debug, Clone, Default)]
pub struct Snapshot {
    /// The machine's name in the console, from the last check-in reply.
    pub machine_name: Option<String>,
    pub last_check_in: Option<SystemTime>,
    /// The last failed check-in or refusal, and when.
    pub last_error: Option<(SystemTime, String)>,
    pub socket_connected: bool,
    pub check_in_seconds: u32,
}

#[derive(Default)]
pub struct StatusBoard {
    state: Mutex<Snapshot>,
    /// Set while the agent tells its server it is leaving (moving or
    /// uninstalling), so the server's `revoked` reply does not stop it first.
    leaving: AtomicBool,
}

impl StatusBoard {
    pub fn new(check_in_seconds: u32) -> Self {
        Self {
            state: Mutex::new(Snapshot {
                check_in_seconds,
                ..Snapshot::default()
            }),
            leaving: AtomicBool::new(false),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Snapshot> {
        // panic = "abort": a poisoned lock cannot hold half-made changes.
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn checked_in(&self, machine_name: &str, check_in_seconds: u32) {
        let mut state = self.lock();
        state.last_check_in = Some(SystemTime::now());
        state.check_in_seconds = check_in_seconds;
        if !machine_name.is_empty() {
            state.machine_name = Some(machine_name.to_string());
        }
    }

    pub fn failed(&self, message: String) {
        self.lock().last_error = Some((SystemTime::now(), message));
    }

    pub fn socket(&self, connected: bool) {
        self.lock().socket_connected = connected;
    }

    pub fn snapshot(&self) -> Snapshot {
        self.lock().clone()
    }

    /// Healthy: the live socket is open, or a check-in worked within three
    /// intervals (the server's own Online rule, SPEC-ENROLMENT 8).
    pub fn healthy(&self, now: SystemTime) -> bool {
        let state = self.lock();
        if state.socket_connected {
            return true;
        }
        let window = Duration::from_secs(u64::from(state.check_in_seconds) * 3);
        state.last_check_in.is_some_and(|at| {
            now.duration_since(at)
                .map(|elapsed| elapsed < window)
                .unwrap_or(true)
        })
    }

    pub fn begin_leaving(&self) {
        self.leaving.store(true, Ordering::SeqCst);
    }

    pub fn end_leaving(&self) {
        self.leaving.store(false, Ordering::SeqCst);
    }

    pub fn is_leaving(&self) -> bool {
        self.leaving.load(Ordering::SeqCst)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn healthy_means_a_socket_or_a_recent_check_in() {
        let board = StatusBoard::new(60);
        let now = SystemTime::now();
        assert!(!board.healthy(now));
        board.checked_in("Reception PC", 60);
        assert!(board.healthy(now));
        assert!(!board.healthy(now + Duration::from_secs(181)));
        board.socket(true);
        assert!(board.healthy(now + Duration::from_secs(181)));
        assert_eq!(
            board.snapshot().machine_name.as_deref(),
            Some("Reception PC")
        );
    }
}
