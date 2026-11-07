//! Which certificate the agent trusts, and how it follows a planned change
//! (SPEC-INSTALL-OPTIONS L7).
//!
//! The server announces the certificate it will serve after its next restart
//! (`pin-update`) over the connection the agent already trusts. The agent
//! keeps using its current trust. Only when a connection under the current
//! trust fails does it try the announced one, and only when that connection
//! works does it adopt it and save it. It never drops the current trust
//! without the new one working.
//!
//! Trade-off: a failure under the current trust (even a network outage) is
//! enough to *try* the next one; that costs one extra attempt, and the next
//! trust is itself something the server announced over a verified channel,
//! so trying it never accepts a server the operator did not choose.

use anyhow::Result;
use bmuster_protocol::ServerTrust;
use std::sync::{Mutex, MutexGuard};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TrustState {
    pub current: ServerTrust,
    /// Announced by the server, not yet proven.
    pub next: Option<ServerTrust>,
}

impl TrustState {
    pub fn new(current: ServerTrust, next: Option<ServerTrust>) -> Self {
        let mut state = Self {
            current,
            next: None,
        };
        if let Some(next) = next {
            state.announce(next);
        }
        state
    }

    /// The server's announcement. Naming the current trust cancels any plan.
    /// Returns whether anything changed.
    pub fn announce(&mut self, next: ServerTrust) -> bool {
        let planned = (next != self.current).then_some(next);
        let changed = planned != self.next;
        self.next = planned;
        changed
    }
}

/// Saves the trust state when it changes (to identity.json).
pub type SaveTrust = Box<dyn Fn(&TrustState) -> Result<()> + Send + Sync>;

/// The shared trust state and what to do when it changes (save it).
pub struct Trust {
    state: Mutex<TrustState>,
    saved: SaveTrust,
}

impl Trust {
    pub fn new(state: TrustState, saved: SaveTrust) -> Self {
        Self {
            state: Mutex::new(state),
            saved,
        }
    }

    fn lock(&self) -> MutexGuard<'_, TrustState> {
        // panic = "abort": a poisoned lock cannot hold half-made changes.
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn state(&self) -> TrustState {
        *self.lock()
    }

    fn save(&self, state: &TrustState) {
        if let Err(e) = (self.saved)(state) {
            log::error!("Could not save the server's certificate pin: {e:#}");
        }
    }

    /// Records a `pin-update` from the server.
    pub fn announce(&self, next: ServerTrust) {
        let mut state = self.lock();
        if state.announce(next) {
            let snapshot = *state;
            drop(state);
            match snapshot.next {
                Some(next) => log::info!(
                    "The server will change its certificate; the next one is {}.",
                    describe(&next)
                ),
                None => log::info!("The server's certificate is not changing."),
            }
            self.save(&snapshot);
        }
    }

    /// Runs `attempt` under the current trust. If it fails and the server
    /// announced a next trust, tries that once; if it works, adopts it.
    pub fn with_fallback<T>(
        &self,
        mut attempt: impl FnMut(&ServerTrust) -> Result<T>,
    ) -> Result<T> {
        let before = self.state();
        let error = match attempt(&before.current) {
            Ok(value) => return Ok(value),
            Err(error) => error,
        };
        let Some(next) = before.next else {
            return Err(error);
        };
        log::info!(
            "Connecting with the current certificate check failed; trying the announced one ({}).",
            describe(&next)
        );
        match attempt(&next) {
            Ok(value) => {
                let mut state = self.lock();
                // Another thread may have promoted it already.
                if state.next == Some(next) {
                    *state = TrustState {
                        current: next,
                        next: None,
                    };
                    let snapshot = *state;
                    drop(state);
                    log::info!("The server now uses {}; saved.", describe(&next));
                    self.save(&snapshot);
                }
                Ok(value)
            }
            Err(also) => {
                log::debug!("The announced certificate check failed too: {also:#}");
                Err(error)
            }
        }
    }
}

pub fn describe(trust: &ServerTrust) -> String {
    match trust {
        ServerTrust::Public => "a certificate the system trusts".into(),
        ServerTrust::Pin { pin } => format!("the pinned key {pin}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use anyhow::bail;
    use bmuster_protocol::CertificatePin;
    use std::sync::Arc;

    fn pin(byte: u8) -> ServerTrust {
        ServerTrust::Pin {
            pin: CertificatePin::of_public_key_info(&[byte]),
        }
    }

    fn trust(
        current: ServerTrust,
        next: Option<ServerTrust>,
    ) -> (Trust, Arc<Mutex<Vec<TrustState>>>) {
        let saves = Arc::new(Mutex::new(Vec::new()));
        let recorder = Arc::clone(&saves);
        let trust = Trust::new(
            TrustState::new(current, next),
            Box::new(move |state| {
                recorder.lock().unwrap().push(*state);
                Ok(())
            }),
        );
        (trust, saves)
    }

    #[test]
    fn announcing_the_current_trust_cancels_a_plan() {
        let mut state = TrustState::new(pin(1), Some(pin(2)));
        assert_eq!(state.next, Some(pin(2)));
        assert!(!state.announce(pin(2)));
        assert!(state.announce(pin(1)));
        assert_eq!(state.next, None);
        assert_eq!(TrustState::new(pin(1), Some(pin(1))).next, None);
    }

    #[test]
    fn announcements_are_saved_only_when_they_change_something() {
        let (trust, saves) = trust(pin(1), None);
        trust.announce(pin(1));
        assert!(saves.lock().unwrap().is_empty());
        trust.announce(ServerTrust::Public);
        trust.announce(ServerTrust::Public);
        assert_eq!(
            *saves.lock().unwrap(),
            [TrustState {
                current: pin(1),
                next: Some(ServerTrust::Public)
            }]
        );
    }

    #[test]
    fn the_current_trust_is_used_while_it_works() {
        let (trust, saves) = trust(pin(1), Some(pin(2)));
        let mut tried = Vec::new();
        let value = trust
            .with_fallback(|check| {
                tried.push(*check);
                Ok(7)
            })
            .unwrap();
        assert_eq!(value, 7);
        assert_eq!(tried, [pin(1)]);
        assert_eq!(trust.state().current, pin(1));
        assert!(saves.lock().unwrap().is_empty());
    }

    #[test]
    fn the_announced_trust_is_adopted_only_once_it_works() {
        let (trust, saves) = trust(pin(1), Some(pin(2)));
        // The server still answers with the old key; the new one fails: keep the old.
        let result: Result<()> = trust.with_fallback(|_| bail!("handshake failed"));
        assert!(result.is_err());
        assert_eq!(trust.state(), TrustState::new(pin(1), Some(pin(2))));
        assert!(saves.lock().unwrap().is_empty());

        // The server restarted with the new key: the old check fails, the new works.
        let mut tried = Vec::new();
        trust
            .with_fallback(|check| {
                tried.push(*check);
                if *check == pin(2) {
                    Ok(())
                } else {
                    bail!("pin mismatch")
                }
            })
            .unwrap();
        assert_eq!(tried, [pin(1), pin(2)]);
        let promoted = TrustState {
            current: pin(2),
            next: None,
        };
        assert_eq!(trust.state(), promoted);
        assert_eq!(*saves.lock().unwrap(), [promoted]);
    }

    #[test]
    fn a_pinned_agent_can_move_to_a_public_certificate() {
        let (trust, _) = trust(pin(1), None);
        trust.announce(ServerTrust::Public);
        trust
            .with_fallback(|check| match check {
                ServerTrust::Public => Ok(()),
                ServerTrust::Pin { .. } => bail!("pin mismatch"),
            })
            .unwrap();
        assert_eq!(trust.state().current, ServerTrust::Public);
    }

    #[test]
    fn without_an_announcement_a_failure_is_just_a_failure() {
        let (trust, _) = trust(pin(1), None);
        let mut attempts = 0;
        let result: Result<()> = trust.with_fallback(|_| {
            attempts += 1;
            bail!("pin mismatch")
        });
        assert_eq!(result.unwrap_err().to_string(), "pin mismatch");
        assert_eq!(attempts, 1);
    }
}
