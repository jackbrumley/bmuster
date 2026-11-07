//! Which console session the desktop helper should run in (SPEC-DESKTOP
//! 6.2): the service polls `WTSGetActiveConsoleSessionId` and asks
//! [`decide`] what to do. Fast user switching, signing out and an RDP
//! session taking the console all show up as a new console session id.
//!
//! The session-watch pattern follows RustDesk's `run_service` loop
//! (`src/platform/windows.rs`, AGPL-3.0), rewritten; see NOTICE.md.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

/// `WTSGetActiveConsoleSessionId` while no session is attached to the
/// console (during a switch).
pub const NO_CONSOLE_SESSION: u32 = 0xFFFF_FFFF;

/// A helper may die this many times within [`RESTART_WINDOW`] before the
/// service gives up and ends its sessions.
pub const MAX_RESTARTS: usize = 3;
pub const RESTART_WINDOW: Duration = Duration::from_secs(60);

/// The helper as the service last saw it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HelperView {
    pub console_session: u32,
    /// False once its process has exited.
    pub running: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Nothing,
    /// Start a helper in this session for the open desktop sessions.
    Start {
        console_session: u32,
    },
    /// The console moved to another session: start a helper there, hand it
    /// every open session, then stop the old one.
    Move {
        from: u32,
        to: u32,
    },
    /// The helper exited while sessions were open: start another and hand
    /// them over (within the restart budget).
    Restart {
        console_session: u32,
    },
    /// No desktop sessions are left: stop the helper.
    Stop,
}

/// A console session a helper can run in. Session 0 holds services only.
fn usable(console_session: u32) -> bool {
    console_session != NO_CONSOLE_SESSION && console_session != 0
}

/// What to do now, given the helper (if any), the console's session id and
/// how many desktop sessions are open.
pub fn decide(helper: Option<HelperView>, active_console: u32, open_sessions: usize) -> Action {
    if open_sessions == 0 {
        return match helper {
            Some(_) => Action::Stop,
            None => Action::Nothing,
        };
    }
    if !usable(active_console) {
        // Mid-switch: keep what runs and look again on the next poll.
        return Action::Nothing;
    }
    match helper {
        None => Action::Start {
            console_session: active_console,
        },
        Some(helper) if !helper.running => Action::Restart {
            console_session: active_console,
        },
        Some(helper) if helper.console_session != active_console => Action::Move {
            from: helper.console_session,
            to: active_console,
        },
        Some(_) => Action::Nothing,
    }
}

/// Counts helper restarts, so a helper that keeps crashing ends its sessions
/// instead of looping.
#[derive(Debug, Default)]
pub struct RestartBudget {
    recent: VecDeque<Instant>,
}

impl RestartBudget {
    /// Records a restart at `now`; false when it is one too many.
    pub fn allow(&mut self, now: Instant) -> bool {
        while self
            .recent
            .front()
            .is_some_and(|at| now.saturating_duration_since(*at) >= RESTART_WINDOW)
        {
            self.recent.pop_front();
        }
        if self.recent.len() >= MAX_RESTARTS {
            return false;
        }
        self.recent.push_back(now);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn helper(console_session: u32, running: bool) -> Option<HelperView> {
        Some(HelperView {
            console_session,
            running,
        })
    }

    #[test]
    fn session_change_starts_a_helper_only_for_open_sessions() {
        assert_eq!(decide(None, 1, 0), Action::Nothing);
        assert_eq!(decide(None, 1, 1), Action::Start { console_session: 1 });
        assert_eq!(decide(helper(1, true), 1, 2), Action::Nothing);
    }

    #[test]
    fn session_change_moves_the_helper_to_the_new_console_session() {
        // Fast user switching, or signing out (a new session for the sign-in screen).
        assert_eq!(
            decide(helper(1, true), 3, 1),
            Action::Move { from: 1, to: 3 }
        );
        // Mid-switch there is no console session: wait, keep the old helper.
        assert_eq!(
            decide(helper(1, true), NO_CONSOLE_SESSION, 1),
            Action::Nothing
        );
        assert_eq!(decide(None, NO_CONSOLE_SESSION, 1), Action::Nothing);
        assert_eq!(decide(None, 0, 1), Action::Nothing);
    }

    #[test]
    fn session_change_restarts_a_dead_helper_and_stops_an_idle_one() {
        assert_eq!(
            decide(helper(1, false), 1, 1),
            Action::Restart { console_session: 1 }
        );
        assert_eq!(
            decide(helper(1, false), 2, 1),
            Action::Restart { console_session: 2 }
        );
        assert_eq!(decide(helper(1, true), 1, 0), Action::Stop);
        assert_eq!(
            decide(helper(1, false), NO_CONSOLE_SESSION, 0),
            Action::Stop
        );
    }

    #[test]
    fn session_change_restart_budget_runs_out_then_refills() {
        let start = Instant::now();
        let mut budget = RestartBudget::default();
        for second in 0..MAX_RESTARTS as u64 {
            assert!(budget.allow(start + Duration::from_secs(second)));
        }
        assert!(!budget.allow(start + Duration::from_secs(10)));
        assert!(budget.allow(start + RESTART_WINDOW + Duration::from_secs(1)));
    }
}
