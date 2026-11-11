//! Who is connected right now (SPEC-LOCAL-PAGE-TRANSPARENCY): every session
//! the agent runs is listed here from the moment its ticket is checked until
//! its thread ends, so the local page can tell the person at the machine
//! whether anyone is connected and who.
//!
//! The names come from the server's signed ticket. They are shown, never
//! trusted for access.

use bmuster_protocol::session::SessionPurpose;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

/// What an open session does on this machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum LiveKind {
    Desktop,
    Terminal,
    Files,
    /// A one-off command (AI commands), not an interactive terminal.
    Command,
}

impl LiveKind {
    pub fn of(purpose: &SessionPurpose) -> Self {
        match purpose {
            SessionPurpose::Desktop { .. } => Self::Desktop,
            SessionPurpose::Terminal { .. } => Self::Terminal,
            SessionPurpose::Files {} => Self::Files,
            SessionPurpose::Exec { .. } => Self::Command,
        }
    }
}

/// One open session, as the local page shows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Open {
    pub kind: LiveKind,
    pub person: String,
}

/// Whether desktop sessions show the "is connected" notice on screen, as
/// the last desktop ticket from the server said.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoticeSetting {
    /// No desktop session since the agent started.
    NotSeen,
    Shown,
    Hidden,
}

struct State {
    open: HashMap<String, Open>,
    notice: NoticeSetting,
}

pub struct Live {
    state: Mutex<State>,
}

impl Default for Live {
    fn default() -> Self {
        Self {
            state: Mutex::new(State {
                open: HashMap::new(),
                notice: NoticeSetting::NotSeen,
            }),
        }
    }
}

/// Removes its session from the list when dropped, however the session ends.
pub struct Entry {
    live: Arc<Live>,
    session_id: String,
}

impl Drop for Entry {
    fn drop(&mut self) {
        self.live.lock().open.remove(&self.session_id);
    }
}

impl Live {
    fn lock(&self) -> MutexGuard<'_, State> {
        // panic = "abort": a poisoned lock cannot hold half-made changes.
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Lists a session until the returned entry is dropped.
    pub fn enter(
        self: &Arc<Self>,
        session_id: &str,
        purpose: &SessionPurpose,
        person: &str,
    ) -> Entry {
        let mut state = self.lock();
        if let SessionPurpose::Desktop { notice, .. } = purpose {
            state.notice = if *notice {
                NoticeSetting::Shown
            } else {
                NoticeSetting::Hidden
            };
        }
        state.open.insert(
            session_id.to_string(),
            Open {
                kind: LiveKind::of(purpose),
                person: person.to_string(),
            },
        );
        Entry {
            live: Arc::clone(self),
            session_id: session_id.to_string(),
        }
    }

    /// The open sessions, by kind and then name, so the page reads the same
    /// on every refresh.
    pub fn open(&self) -> Vec<Open> {
        let mut open: Vec<Open> = self.lock().open.values().cloned().collect();
        open.sort_by(|a, b| a.kind.cmp(&b.kind).then_with(|| a.person.cmp(&b.person)));
        open
    }

    pub fn notice(&self) -> NoticeSetting {
        self.lock().notice
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bmuster_protocol::session::{Consent, Shell};

    #[test]
    fn sessions_are_listed_until_their_entry_drops() {
        let live = Arc::new(Live::default());
        assert!(live.open().is_empty());
        assert_eq!(live.notice(), NoticeSetting::NotSeen);

        let terminal = live.enter(
            "s1",
            &SessionPurpose::Terminal {
                shell: Shell::Sh,
                cols: 80,
                rows: 24,
            },
            "Jack Brumley",
        );
        let desktop = live.enter(
            "s2",
            &SessionPurpose::Desktop {
                consent: Consent::Unattended,
                notice: false,
            },
            "Sam Lee",
        );
        assert_eq!(
            live.open(),
            [
                Open {
                    kind: LiveKind::Desktop,
                    person: "Sam Lee".into()
                },
                Open {
                    kind: LiveKind::Terminal,
                    person: "Jack Brumley".into()
                }
            ]
        );
        assert_eq!(live.notice(), NoticeSetting::Hidden);

        drop(desktop);
        assert_eq!(live.open().len(), 1);
        drop(terminal);
        assert!(live.open().is_empty());
        // The notice setting is what the server said last, not who is on.
        assert_eq!(live.notice(), NoticeSetting::Hidden);
    }
}
