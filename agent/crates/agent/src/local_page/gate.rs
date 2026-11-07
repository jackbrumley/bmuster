//! Who may use the local page: a 6-digit code from the console (TOTP), at
//! most 5 wrong codes before a 5-minute pause, sessions that end 1 hour after
//! the last action and 12 hours after sign-in, forms only from the page
//! itself, and (while it listens only on this machine) only the local names.

use crate::totp;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

pub const COOKIE: &str = "bmuster_local_session";
pub const MAX_FAILURES: u32 = 5;
pub const PAUSE_MS: u64 = 5 * 60_000;
pub const IDLE_LIMIT_MS: u64 = 60 * 60_000;
pub const MAX_SESSION_MS: u64 = 12 * 60 * 60_000;
/// Sessions beyond this many push out the oldest.
const MAX_SESSIONS: usize = 32;

#[derive(Debug, PartialEq, Eq)]
pub enum SignIn {
    SignedIn {
        token: String,
    },
    Wrong {
        left: u32,
    },
    Paused {
        seconds: u64,
    },
    /// The right code, but it already signed someone in.
    AlreadyUsed,
}

#[derive(Clone, Copy)]
struct Times {
    created_ms: u64,
    last_ms: u64,
}

#[derive(Default)]
struct State {
    failures: u32,
    paused_until_ms: u64,
    /// The newest code step that signed someone in; a code works once.
    last_step: Option<u64>,
    /// SHA-256 (hex) of each session token, so memory never holds a usable token.
    sessions: HashMap<String, Times>,
}

pub struct Gate {
    secret: Vec<u8>,
    state: Mutex<State>,
}

fn token_hash(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

impl Gate {
    pub fn new(secret: &[u8]) -> Self {
        Self {
            secret: secret.to_vec(),
            state: Mutex::new(State::default()),
        }
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        // panic = "abort": a poisoned lock cannot hold half-made changes.
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Checks a typed code (spaces ignored) at `now_ms` (Unix milliseconds).
    pub fn sign_in(&self, typed: &str, now_ms: u64) -> SignIn {
        let mut state = self.lock();
        if now_ms < state.paused_until_ms {
            return SignIn::Paused {
                seconds: (state.paused_until_ms - now_ms).div_ceil(1000),
            };
        }
        let code: String = typed.chars().filter(|c| !c.is_whitespace()).collect();
        match totp::matching_step(&self.secret, &code, now_ms / 1000) {
            Some(step) if state.last_step.is_some_and(|last| step <= last) => SignIn::AlreadyUsed,
            Some(step) => {
                state.failures = 0;
                state.last_step = Some(step);
                let token = new_token();
                state.sessions.retain(|_, times| alive(*times, now_ms));
                if state.sessions.len() >= MAX_SESSIONS {
                    let oldest = state
                        .sessions
                        .iter()
                        .min_by_key(|(_, times)| times.last_ms)
                        .map(|(key, _)| key.clone());
                    if let Some(key) = oldest {
                        state.sessions.remove(&key);
                    }
                }
                state.sessions.insert(
                    token_hash(&token),
                    Times {
                        created_ms: now_ms,
                        last_ms: now_ms,
                    },
                );
                SignIn::SignedIn { token }
            }
            None => {
                state.failures += 1;
                if state.failures >= MAX_FAILURES {
                    state.failures = 0;
                    state.paused_until_ms = now_ms + PAUSE_MS;
                    log::warn!(
                        "Local page: {MAX_FAILURES} wrong codes; sign-in is paused for 5 minutes."
                    );
                    SignIn::Paused {
                        seconds: PAUSE_MS / 1000,
                    }
                } else {
                    SignIn::Wrong {
                        left: MAX_FAILURES - state.failures,
                    }
                }
            }
        }
    }

    /// Whether `token` is a live session; counts as an action (extends it).
    pub fn session(&self, token: Option<&str>, now_ms: u64) -> bool {
        let Some(token) = token else {
            return false;
        };
        let key = token_hash(token);
        let mut state = self.lock();
        match state.sessions.get_mut(&key) {
            Some(times) if alive(*times, now_ms) => {
                times.last_ms = now_ms;
                true
            }
            Some(_) => {
                state.sessions.remove(&key);
                false
            }
            None => false,
        }
    }

    pub fn sign_out(&self, token: Option<&str>) {
        if let Some(token) = token {
            self.lock().sessions.remove(&token_hash(token));
        }
    }
}

fn alive(times: Times, now_ms: u64) -> bool {
    now_ms.saturating_sub(times.last_ms) < IDLE_LIMIT_MS
        && now_ms.saturating_sub(times.created_ms) < MAX_SESSION_MS
}

fn new_token() -> String {
    let mut bytes = [0u8; 32];
    // getrandom failing means the system has no randomness; nothing is safe then.
    getrandom::getrandom(&mut bytes).expect("the system's random number source failed");
    hex::encode(bytes)
}

/// Where the page listens decides which `Host` names it answers to.
#[derive(Debug, Clone, Copy)]
pub struct Hosts {
    pub port: u16,
    /// Listening on loopback only: answer only to `localhost`, `127.0.0.1`
    /// and `[::1]`, so a web page that points its own name at 127.0.0.1 (DNS
    /// rebinding) is refused.
    pub loopback_only: bool,
}

impl Hosts {
    pub fn allows(&self, host: Option<&str>) -> bool {
        let Some(host) = host else {
            return false;
        };
        if !self.loopback_only {
            return true;
        }
        let host = host.to_ascii_lowercase();
        ["localhost", "127.0.0.1", "[::1]"]
            .iter()
            .any(|name| host == format!("{name}:{}", self.port))
    }
}

/// A form counts only when the browser says it came from this page's own
/// address (the `Origin` of a POST).
pub fn same_origin(origin: Option<&str>, host: Option<&str>) -> bool {
    match (origin, host) {
        (Some(origin), Some(host)) => origin.eq_ignore_ascii_case(&format!("https://{host}")),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &[u8] = b"12345678901234567890";
    /// 2033-05-18T03:33:20Z, a step start, so neighbouring steps are exact.
    const NOW_MS: u64 = 2_000_000_010_000;

    fn code_at(ms: u64) -> String {
        totp::code_for_step(SECRET, totp::step_at(ms / 1000), totp::DIGITS)
    }

    fn wrong_code(ms: u64) -> String {
        let right = code_at(ms);
        let near: Vec<String> = (0..3).map(|d| code_at(ms + d * 30_000 - 30_000)).collect();
        (0..1_000_000)
            .map(|n| format!("{n:06}"))
            .find(|c| *c != right && !near.contains(c))
            .unwrap()
    }

    #[test]
    fn the_right_code_signs_in_once() {
        let gate = Gate::new(SECRET);
        let code = code_at(NOW_MS);
        let SignIn::SignedIn { token } = gate.sign_in(&code, NOW_MS) else {
            panic!("the right code was refused");
        };
        assert!(gate.session(Some(&token), NOW_MS + 1));
        // Spaces are fine, but the same code does not work twice.
        let spaced = format!("{} {}", &code[..3], &code[3..]);
        assert_eq!(gate.sign_in(&spaced, NOW_MS + 2), SignIn::AlreadyUsed);
        // The next step's code works.
        assert!(matches!(
            gate.sign_in(&code_at(NOW_MS + 30_000), NOW_MS + 30_000),
            SignIn::SignedIn { .. }
        ));
    }

    #[test]
    fn five_wrong_codes_pause_sign_in_for_five_minutes() {
        let gate = Gate::new(SECRET);
        let wrong = wrong_code(NOW_MS);
        for left in (1..MAX_FAILURES).rev() {
            assert_eq!(gate.sign_in(&wrong, NOW_MS), SignIn::Wrong { left });
        }
        assert_eq!(
            gate.sign_in(&wrong, NOW_MS),
            SignIn::Paused { seconds: 300 }
        );
        // Even the right code waits out the pause.
        let later = NOW_MS + 60_000;
        assert_eq!(
            gate.sign_in(&code_at(later), later),
            SignIn::Paused { seconds: 240 }
        );
        let after = NOW_MS + PAUSE_MS;
        assert!(matches!(
            gate.sign_in(&code_at(after), after),
            SignIn::SignedIn { .. }
        ));
    }

    #[test]
    fn a_right_code_resets_the_count() {
        let gate = Gate::new(SECRET);
        let wrong = wrong_code(NOW_MS);
        for _ in 0..4 {
            gate.sign_in(&wrong, NOW_MS);
        }
        assert!(matches!(
            gate.sign_in(&code_at(NOW_MS), NOW_MS),
            SignIn::SignedIn { .. }
        ));
        assert_eq!(gate.sign_in(&wrong, NOW_MS + 1), SignIn::Wrong { left: 4 });
    }

    fn signed_in(gate: &Gate, at: u64) -> String {
        match gate.sign_in(&code_at(at), at) {
            SignIn::SignedIn { token } => token,
            other => panic!("not signed in: {other:?}"),
        }
    }

    #[test]
    fn a_session_ends_an_hour_after_the_last_action() {
        let gate = Gate::new(SECRET);
        let token = signed_in(&gate, NOW_MS);
        let used = NOW_MS + IDLE_LIMIT_MS - 1;
        assert!(gate.session(Some(&token), used), "still within the hour");
        assert!(
            gate.session(Some(&token), used + IDLE_LIMIT_MS - 1),
            "renewed by the last action"
        );
        assert!(!gate.session(Some(&token), used + 2 * IDLE_LIMIT_MS));
        assert!(
            !gate.session(Some(&token), used),
            "an ended session stays ended"
        );
    }

    #[test]
    fn a_session_ends_twelve_hours_after_sign_in_however_busy() {
        let gate = Gate::new(SECRET);
        let token = signed_in(&gate, NOW_MS);
        let mut at = NOW_MS;
        while at < NOW_MS + MAX_SESSION_MS - 30 * 60_000 {
            at += 30 * 60_000;
            assert!(gate.session(Some(&token), at));
        }
        assert!(!gate.session(Some(&token), NOW_MS + MAX_SESSION_MS));
    }

    #[test]
    fn signing_out_and_unknown_tokens() {
        let gate = Gate::new(SECRET);
        let token = signed_in(&gate, NOW_MS);
        assert!(!gate.session(None, NOW_MS));
        assert!(!gate.session(Some("not-a-token"), NOW_MS));
        gate.sign_out(Some(&token));
        assert!(!gate.session(Some(&token), NOW_MS));
    }

    #[test]
    fn forms_must_come_from_the_page_itself() {
        assert!(same_origin(
            Some("https://localhost:47500"),
            Some("localhost:47500")
        ));
        assert!(!same_origin(
            Some("https://evil.example"),
            Some("localhost:47500")
        ));
        assert!(!same_origin(
            Some("http://localhost:47500"),
            Some("localhost:47500")
        ));
        assert!(!same_origin(None, Some("localhost:47500")));
        assert!(!same_origin(Some("null"), Some("localhost:47500")));
    }

    #[test]
    fn loopback_pages_answer_only_to_local_names() {
        let local = Hosts {
            port: 47500,
            loopback_only: true,
        };
        assert!(local.allows(Some("localhost:47500")));
        assert!(local.allows(Some("127.0.0.1:47500")));
        assert!(local.allows(Some("[::1]:47500")));
        assert!(!local.allows(Some("rebound.example:47500")));
        assert!(!local.allows(Some("localhost:47400")));
        assert!(!local.allows(None));
        let open = Hosts {
            port: 47500,
            loopback_only: false,
        };
        assert!(open.allows(Some("192.168.1.20:47500")));
    }
}
