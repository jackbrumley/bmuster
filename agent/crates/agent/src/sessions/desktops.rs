//! The desktop sessions running on this agent, by id, while their threads
//! run (SPEC-SESSION-FILES 4.2): a `session-files` session is admitted
//! only for a live control session of the same person, and ends when that
//! desktop session does. Filled from the signed desktop tickets, never
//! from anything a browser sends.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex, MutexGuard};

#[derive(Debug, Clone, PartialEq, Eq)]
struct Desktop {
    user_id: String,
    control: bool,
}

static LIVE: LazyLock<Mutex<HashMap<String, Desktop>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn live() -> MutexGuard<'static, HashMap<String, Desktop>> {
    LIVE.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Listed until dropped, however the desktop session ends.
pub struct Listed(String);

impl Drop for Listed {
    fn drop(&mut self) {
        live().remove(&self.0);
    }
}

/// Lists a desktop session: whose ticket it is, and whether it controls.
pub fn enter(session_id: &str, user_id: &str, control: bool) -> Listed {
    live().insert(
        session_id.to_string(),
        Desktop {
            user_id: user_id.to_string(),
            control,
        },
    );
    Listed(session_id.to_string())
}

pub fn is_live(session_id: &str) -> bool {
    live().contains_key(session_id)
}

/// Why a session-files ticket may not use `desktop_session_id`, if it may not.
pub fn refuse_link(desktop_session_id: &str, user_id: &str) -> Option<&'static str> {
    match live().get(desktop_session_id) {
        None => Some("the desktop session it names is not running on this machine"),
        Some(desktop) if desktop.user_id != user_id => {
            Some("the desktop session it names is someone else's")
        }
        Some(desktop) if !desktop.control => Some("the desktop session it names only watches"),
        Some(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// SF2: only a live control session of the same person.
    #[test]
    fn sf2_session_files_needs_a_live_control_session_of_the_same_person() {
        assert!(refuse_link("d-sf2", "u1").is_some(), "not live");
        let watch = enter("d-sf2-watch", "u1", false);
        assert_eq!(
            refuse_link("d-sf2-watch", "u1"),
            Some("the desktop session it names only watches")
        );
        drop(watch);
        let listed = enter("d-sf2", "u1", true);
        assert_eq!(refuse_link("d-sf2", "u1"), None);
        assert_eq!(
            refuse_link("d-sf2", "u2"),
            Some("the desktop session it names is someone else's")
        );
        assert!(is_live("d-sf2"));
        drop(listed);
        assert!(!is_live("d-sf2"), "ends with the desktop session");
        assert!(refuse_link("d-sf2", "u1").is_some());
    }
}
