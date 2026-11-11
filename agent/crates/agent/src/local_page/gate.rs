//! Who may use the local page: a 6-digit code (TOTP), each person's own
//! from the console (or the shared machine code until the server sends a
//! list of people), at most 5 wrong codes before a 5-minute pause, sessions
//! that end 1 hour after the last action and 12 hours after sign-in, forms
//! only from the page itself, and (while it listens only on this machine)
//! only the local names. Sign-ins, wrong codes, lockouts, sign-outs and
//! ended sessions go to the event journal (SPEC-AGENT-LOCAL 7).

use super::journal::Journal;
use super::people::{Mode, People};
use crate::totp;
use bmuster_protocol::{CodeOwners, LocalEvent};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, Mutex, MutexGuard};

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
    /// This wrong code was the fifth: sign-in is paused from now.
    LockedOut {
        seconds: u64,
    },
    Paused {
        seconds: u64,
    },
    /// The right code, but it already signed someone in.
    AlreadyUsed,
}

#[derive(Clone)]
struct Session {
    created_ms: u64,
    last_ms: u64,
    codes: CodeOwners,
}

#[derive(Default)]
struct State {
    failures: u32,
    paused_until_ms: u64,
    /// The newest code step that signed someone in, whoever's code it was;
    /// a step works once per machine.
    last_step: Option<u64>,
    /// SHA-256 (hex) of each session token, so memory never holds a usable token.
    sessions: HashMap<String, Session>,
}

pub struct Gate {
    machine_secret: Vec<u8>,
    people: Arc<People>,
    journal: Arc<Journal>,
    state: Mutex<State>,
}

fn token_hash(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}

impl Gate {
    pub fn new(machine_secret: &[u8], people: Arc<People>, journal: Arc<Journal>) -> Self {
        Self {
            machine_secret: machine_secret.to_vec(),
            people,
            journal,
            state: Mutex::new(State::default()),
        }
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        // panic = "abort": a poisoned lock cannot hold half-made changes.
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The step and owners of a code that matches now. With a list, every
    /// listed person whose own code matches is named (two matching at once
    /// is about one in a million per pair, and still signs in).
    fn matching(&self, code: &str, unix_seconds: u64) -> Option<(u64, CodeOwners)> {
        match self.people.mode() {
            Mode::Shared => totp::matching_step(&self.machine_secret, code, unix_seconds)
                .map(|step| (step, CodeOwners::Machine)),
            Mode::Damaged => None,
            Mode::People(users) => {
                let mut step = None;
                let mut people = Vec::new();
                for user in users {
                    let secret = totp::user_secret(&self.machine_secret, &user.user_id);
                    if let Some(found) = totp::matching_step(&secret, code, unix_seconds) {
                        step = step.max(Some(found));
                        people.push(user);
                    }
                }
                step.map(|step| (step, CodeOwners::People { people }))
            }
        }
    }

    /// Whether these owners may still be signed in: a session from the
    /// shared code ends once a list arrives, and a person's ends once they
    /// are off the list.
    fn still_allowed(&self, codes: &CodeOwners) -> bool {
        match (self.people.mode(), codes) {
            (Mode::Shared, CodeOwners::Machine) => true,
            (Mode::People(users), CodeOwners::People { people }) => people
                .iter()
                .any(|person| users.iter().any(|user| user.user_id == person.user_id)),
            _ => false,
        }
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
        match self.matching(&code, now_ms / 1000) {
            Some((step, _)) if state.last_step.is_some_and(|last| step <= last) => {
                SignIn::AlreadyUsed
            }
            Some((step, codes)) => {
                state.failures = 0;
                state.last_step = Some(step);
                let token = new_token();
                self.end_sessions(&mut state, now_ms);
                if state.sessions.len() >= MAX_SESSIONS {
                    let oldest = state
                        .sessions
                        .iter()
                        .min_by_key(|(_, session)| session.last_ms)
                        .map(|(key, _)| key.clone());
                    if let Some(session) = oldest.and_then(|key| state.sessions.remove(&key)) {
                        self.journal.record_at(
                            LocalEvent::SessionExpired {
                                codes: session.codes,
                            },
                            now_ms,
                        );
                    }
                }
                state.sessions.insert(
                    token_hash(&token),
                    Session {
                        created_ms: now_ms,
                        last_ms: now_ms,
                        codes: codes.clone(),
                    },
                );
                log::info!("Local page: signed in with {}.", whose_code(&codes));
                self.journal
                    .record_at(LocalEvent::SignedIn { codes }, now_ms);
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
                    self.journal.record_at(LocalEvent::LockedOut, now_ms);
                    SignIn::LockedOut {
                        seconds: PAUSE_MS / 1000,
                    }
                } else {
                    self.journal.record_at(LocalEvent::WrongCode, now_ms);
                    SignIn::Wrong {
                        left: MAX_FAILURES - state.failures,
                    }
                }
            }
        }
    }

    /// Ends (and records) every session past its time or whose owner may no
    /// longer sign in.
    fn end_sessions(&self, state: &mut State, now_ms: u64) -> bool {
        let ended: Vec<String> = state
            .sessions
            .iter()
            .filter(|(_, session)| !alive(session, now_ms) || !self.still_allowed(&session.codes))
            .map(|(key, _)| key.clone())
            .collect();
        for key in &ended {
            if let Some(session) = state.sessions.remove(key) {
                self.journal.record_at(
                    LocalEvent::SessionExpired {
                        codes: session.codes,
                    },
                    now_ms,
                );
            }
        }
        !ended.is_empty()
    }

    /// Ends sessions that ran out while nobody used the page; called now and
    /// then so an idle session's end is recorded close to when it happened.
    /// Returns whether any ended.
    pub fn sweep(&self, now_ms: u64) -> bool {
        let mut state = self.lock();
        self.end_sessions(&mut state, now_ms)
    }

    /// Whose code a live session signed in with; using it counts as an
    /// action (extends it). `None` when there is no live session.
    pub fn session(&self, token: Option<&str>, now_ms: u64) -> Option<CodeOwners> {
        let key = token_hash(token?);
        let mut state = self.lock();
        let live = state
            .sessions
            .get(&key)
            .map(|session| alive(session, now_ms) && self.still_allowed(&session.codes))?;
        if !live {
            self.end_sessions(&mut state, now_ms);
            return None;
        }
        let session = state.sessions.get_mut(&key)?;
        session.last_ms = now_ms;
        Some(session.codes.clone())
    }

    pub fn sign_out(&self, token: Option<&str>, now_ms: u64) {
        let Some(token) = token else {
            return;
        };
        if let Some(session) = self.lock().sessions.remove(&token_hash(token)) {
            self.journal.record_at(
                LocalEvent::SignedOut {
                    codes: session.codes,
                },
                now_ms,
            );
        }
    }
}

/// Whose code a session signed in with, in words.
pub fn whose_code(codes: &CodeOwners) -> String {
    match codes {
        CodeOwners::Machine => "the shared machine code".into(),
        // Several only when their codes matched at once.
        CodeOwners::People { people } => people
            .iter()
            .map(|person| format!("{}'s code", person.name))
            .collect::<Vec<_>>()
            .join(" and "),
    }
}

fn alive(session: &Session, now_ms: u64) -> bool {
    now_ms.saturating_sub(session.last_ms) < IDLE_LIMIT_MS
        && now_ms.saturating_sub(session.created_ms) < MAX_SESSION_MS
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
        self.is_loopback_name(host)
    }

    /// `localhost`, `127.0.0.1` or `[::1]` with this page's port.
    fn is_loopback_name(&self, host: &str) -> bool {
        let host = host.to_ascii_lowercase();
        ["localhost", "127.0.0.1", "[::1]"]
            .iter()
            .any(|name| host == format!("{name}:{}", self.port))
    }

    /// Whether the visitor sits at this computer (SPEC-LOCAL-PAGE-TRANSPARENCY):
    /// the connection comes from a loopback address (127.0.0.0/8 or ::1, also
    /// IPv4-mapped) and the browser asked for a loopback name. The name check
    /// matters while the page is open to the network, where any `Host` is
    /// answered: without it a web page that points its own name at
    /// 127.0.0.1 (DNS rebinding) could read the details in a local browser.
    pub fn visitor(&self, peer: IpAddr, host: Option<&str>) -> Visitor {
        if peer.to_canonical().is_loopback() && host.is_some_and(|host| self.is_loopback_name(host))
        {
            Visitor::AtThisComputer
        } else {
            Visitor::FromTheNetwork
        }
    }
}

/// Who opened the page, for what it shows before sign-in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Visitor {
    /// Sees who manages the computer, its server and who is connected.
    AtThisComputer,
    /// Sees only the sign-in form and how to remove BMuster.
    FromTheNetwork,
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
    use bmuster_protocol::{LocalUser, LocalUsersUpdate};

    const SECRET: &[u8] = b"12345678901234567890";
    /// 2033-05-18T03:33:20Z, a step start, so neighbouring steps are exact.
    const NOW_MS: u64 = 2_000_000_010_000;

    struct Fixture {
        _dir: tempfile::TempDir,
        gate: Gate,
        people: Arc<People>,
        journal: Arc<Journal>,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let people = Arc::new(People::load(dir.path()));
        let journal = Arc::new(Journal::open(dir.path()));
        Fixture {
            gate: Gate::new(SECRET, Arc::clone(&people), Arc::clone(&journal)),
            _dir: dir,
            people,
            journal,
        }
    }

    fn user(id: &str, name: &str) -> LocalUser {
        LocalUser {
            user_id: id.into(),
            name: name.into(),
        }
    }

    fn list(people: &People, users: Vec<LocalUser>) {
        people
            .apply(&LocalUsersUpdate::List {
                hash: format!("{}", users.len()),
                users,
            })
            .unwrap();
    }

    fn code_with(secret: &[u8], ms: u64) -> String {
        totp::code_for_step(secret, totp::step_at(ms / 1000), totp::DIGITS)
    }

    fn code_at(ms: u64) -> String {
        code_with(SECRET, ms)
    }

    fn person_code(user_id: &str, ms: u64) -> String {
        code_with(&totp::user_secret(SECRET, user_id), ms)
    }

    fn wrong_code(ms: u64) -> String {
        let near: Vec<String> = (0..3)
            .flat_map(|d| {
                let at = ms + d * 30_000 - 30_000;
                [code_at(at), person_code("ann", at), person_code("ben", at)]
            })
            .collect();
        (0..1_000_000)
            .map(|n| format!("{n:06}"))
            .find(|c| !near.contains(c))
            .unwrap()
    }

    fn events(journal: &Journal) -> Vec<LocalEvent> {
        journal.entries().into_iter().map(|e| e.event).collect()
    }

    #[test]
    fn the_right_code_signs_in_once() {
        let f = fixture();
        let code = code_at(NOW_MS);
        let SignIn::SignedIn { token } = f.gate.sign_in(&code, NOW_MS) else {
            panic!("the right code was refused");
        };
        assert_eq!(
            f.gate.session(Some(&token), NOW_MS + 1),
            Some(CodeOwners::Machine)
        );
        // Spaces are fine, but the same code does not work twice.
        let spaced = format!("{} {}", &code[..3], &code[3..]);
        assert_eq!(f.gate.sign_in(&spaced, NOW_MS + 2), SignIn::AlreadyUsed);
        // The next step's code works.
        assert!(matches!(
            f.gate.sign_in(&code_at(NOW_MS + 30_000), NOW_MS + 30_000),
            SignIn::SignedIn { .. }
        ));
        assert_eq!(
            events(&f.journal),
            [
                LocalEvent::SignedIn {
                    codes: CodeOwners::Machine
                },
                LocalEvent::SignedIn {
                    codes: CodeOwners::Machine
                }
            ]
        );
    }

    /// P6: with a list only the listed people's own codes work, and the
    /// session knows whose code it was.
    #[test]
    fn with_a_list_only_peoples_own_codes_sign_in() {
        let f = fixture();
        list(&f.people, vec![user("ann", "Ann"), user("ben", "Ben")]);
        assert!(matches!(
            f.gate.sign_in(&code_at(NOW_MS), NOW_MS),
            SignIn::Wrong { left: 4 }
        ));
        let SignIn::SignedIn { token } = f.gate.sign_in(&person_code("ben", NOW_MS), NOW_MS) else {
            panic!("Ben's code was refused");
        };
        let ben = CodeOwners::People {
            people: vec![user("ben", "Ben")],
        };
        assert_eq!(f.gate.session(Some(&token), NOW_MS), Some(ben.clone()));
        // Single use is per machine: Ann's code in the same step is refused.
        assert_eq!(
            f.gate.sign_in(&person_code("ann", NOW_MS), NOW_MS + 1),
            SignIn::AlreadyUsed
        );
        assert_eq!(
            events(&f.journal),
            [LocalEvent::WrongCode, LocalEvent::SignedIn { codes: ben }]
        );
    }

    /// P5: someone removed from the list stops working at the next check-in,
    /// and their session ends.
    #[test]
    fn someone_taken_off_the_list_is_signed_out_and_refused() {
        let f = fixture();
        list(&f.people, vec![user("ann", "Ann"), user("ben", "Ben")]);
        let SignIn::SignedIn { token } = f.gate.sign_in(&person_code("ben", NOW_MS), NOW_MS) else {
            panic!("Ben's code was refused");
        };
        list(&f.people, vec![user("ann", "Ann")]);
        assert_eq!(f.gate.session(Some(&token), NOW_MS + 1), None);
        let later = NOW_MS + 30_000;
        assert!(matches!(
            f.gate.sign_in(&person_code("ben", later), later),
            SignIn::Wrong { .. }
        ));
        assert!(matches!(
            f.gate.sign_in(&person_code("ann", later), later),
            SignIn::SignedIn { .. }
        ));
        assert!(events(&f.journal).contains(&LocalEvent::SessionExpired {
            codes: CodeOwners::People {
                people: vec![user("ben", "Ben")]
            }
        }));
    }

    #[test]
    fn a_session_from_the_shared_code_ends_when_a_list_arrives() {
        let f = fixture();
        let SignIn::SignedIn { token } = f.gate.sign_in(&code_at(NOW_MS), NOW_MS) else {
            panic!("the shared code was refused");
        };
        list(&f.people, vec![user("ann", "Ann")]);
        assert_eq!(f.gate.session(Some(&token), NOW_MS + 1), None);
    }

    /// P6: two people whose codes match at once both sign in, both named.
    #[test]
    fn several_matching_people_are_all_named() {
        let f = fixture();
        // "twin-1634086" was found by searching (about a million tries) for
        // an id whose code matches Ann's in this step.
        let twin = "twin-1634086";
        let ann = person_code("ann", NOW_MS);
        assert_eq!(person_code(twin, NOW_MS), ann);
        list(&f.people, vec![user("ann", "Ann"), user(twin, "Twin")]);
        assert!(matches!(
            f.gate.sign_in(&ann, NOW_MS),
            SignIn::SignedIn { .. }
        ));
        assert_eq!(
            events(&f.journal),
            [LocalEvent::SignedIn {
                codes: CodeOwners::People {
                    people: vec![user("ann", "Ann"), user(twin, "Twin")]
                }
            }]
        );
    }

    #[test]
    fn a_damaged_list_lets_nobody_in() {
        let f = fixture();
        crate::identity::write_private(&f._dir.path().join(crate::paths::LOCAL_USERS_FILE), b"[")
            .unwrap();
        let gate = Gate::new(
            SECRET,
            Arc::new(People::load(f._dir.path())),
            Arc::clone(&f.journal),
        );
        assert!(matches!(
            gate.sign_in(&code_at(NOW_MS), NOW_MS),
            SignIn::Wrong { .. }
        ));
    }

    #[test]
    fn five_wrong_codes_pause_sign_in_for_five_minutes() {
        let f = fixture();
        let gate = &f.gate;
        let wrong = wrong_code(NOW_MS);
        for left in (1..MAX_FAILURES).rev() {
            assert_eq!(gate.sign_in(&wrong, NOW_MS), SignIn::Wrong { left });
        }
        assert_eq!(
            gate.sign_in(&wrong, NOW_MS),
            SignIn::LockedOut { seconds: 300 }
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
        let recorded = events(&f.journal);
        assert_eq!(
            recorded[..5],
            [
                LocalEvent::WrongCode,
                LocalEvent::WrongCode,
                LocalEvent::WrongCode,
                LocalEvent::WrongCode,
                LocalEvent::LockedOut
            ]
        );
        assert_eq!(recorded.len(), 6, "a paused try is not an event");
    }

    #[test]
    fn the_pause_is_per_machine_whoever_types() {
        let f = fixture();
        list(&f.people, vec![user("ann", "Ann"), user("ben", "Ben")]);
        let wrong = wrong_code(NOW_MS);
        for _ in 0..MAX_FAILURES {
            f.gate.sign_in(&wrong, NOW_MS);
        }
        assert!(matches!(
            f.gate.sign_in(&person_code("ann", NOW_MS), NOW_MS),
            SignIn::Paused { .. }
        ));
    }

    #[test]
    fn a_right_code_resets_the_count() {
        let f = fixture();
        let gate = &f.gate;
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
        let f = fixture();
        let gate = &f.gate;
        let token = signed_in(gate, NOW_MS);
        let used = NOW_MS + IDLE_LIMIT_MS - 1;
        assert!(
            gate.session(Some(&token), used).is_some(),
            "still within the hour"
        );
        assert!(
            gate.session(Some(&token), used + IDLE_LIMIT_MS - 1)
                .is_some(),
            "renewed by the last action"
        );
        assert!(gate
            .session(Some(&token), used + 2 * IDLE_LIMIT_MS)
            .is_none());
        assert!(
            gate.session(Some(&token), used).is_none(),
            "an ended session stays ended"
        );
        assert_eq!(
            events(&f.journal).last(),
            Some(&LocalEvent::SessionExpired {
                codes: CodeOwners::Machine
            })
        );
    }

    #[test]
    fn an_idle_session_is_swept_and_recorded() {
        let f = fixture();
        signed_in(&f.gate, NOW_MS);
        f.gate.sweep(NOW_MS + 1000);
        assert_eq!(events(&f.journal).len(), 1);
        f.gate.sweep(NOW_MS + IDLE_LIMIT_MS);
        assert_eq!(
            events(&f.journal).last(),
            Some(&LocalEvent::SessionExpired {
                codes: CodeOwners::Machine
            })
        );
    }

    #[test]
    fn a_session_ends_twelve_hours_after_sign_in_however_busy() {
        let f = fixture();
        let gate = &f.gate;
        let token = signed_in(gate, NOW_MS);
        let mut at = NOW_MS;
        while at < NOW_MS + MAX_SESSION_MS - 30 * 60_000 {
            at += 30 * 60_000;
            assert!(gate.session(Some(&token), at).is_some());
        }
        assert!(gate
            .session(Some(&token), NOW_MS + MAX_SESSION_MS)
            .is_none());
    }

    #[test]
    fn signing_out_and_unknown_tokens() {
        let f = fixture();
        let gate = &f.gate;
        let token = signed_in(gate, NOW_MS);
        assert!(gate.session(None, NOW_MS).is_none());
        assert!(gate.session(Some("not-a-token"), NOW_MS).is_none());
        gate.sign_out(Some(&token), NOW_MS);
        assert!(gate.session(Some(&token), NOW_MS).is_none());
        assert_eq!(
            events(&f.journal).last(),
            Some(&LocalEvent::SignedOut {
                codes: CodeOwners::Machine
            })
        );
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

    #[test]
    fn only_loopback_visitors_asking_for_a_local_name_are_at_this_computer() {
        let open = Hosts {
            port: 47500,
            loopback_only: false,
        };
        let peer = |text: &str| text.parse::<IpAddr>().unwrap();
        for (address, host) in [
            ("127.0.0.1", "localhost:47500"),
            ("127.8.9.10", "127.0.0.1:47500"),
            ("::1", "[::1]:47500"),
            ("::ffff:127.0.0.1", "localhost:47500"),
        ] {
            assert_eq!(
                open.visitor(peer(address), Some(host)),
                Visitor::AtThisComputer,
                "{address} {host}"
            );
        }
        for (address, host) in [
            ("192.168.1.20", Some("192.168.1.5:47500")),
            ("10.0.0.1", Some("localhost:47500")),
            ("::ffff:192.168.1.20", Some("localhost:47500")),
            ("fe80::1", Some("localhost:47500")),
            // DNS rebinding: a loopback connection to a name that is not local.
            ("127.0.0.1", Some("rebound.example:47500")),
            ("127.0.0.1", Some("localhost:47400")),
            ("127.0.0.1", None),
        ] {
            assert_eq!(
                open.visitor(peer(address), host),
                Visitor::FromTheNetwork,
                "{address} {host:?}"
            );
        }
    }
}
