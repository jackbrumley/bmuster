//! When the agent starts a tray helper for someone (SPEC-TRAY-SESSIONS 4),
//! the same on Linux and Windows: each platform's starter says who is signed
//! in, whether their helper runs and how to start one; [`Starter`] decides
//! when. Someone must have been seen for the platform's settle time before
//! their first start, gets nothing while their helper runs, and gets at most
//! one attempt in [`RETRY`].

use std::collections::HashMap;
use std::hash::Hash;
use std::time::{Duration, Instant};

/// Linux: how long someone is seen before their first start, so their
/// desktop has imported its environment into the user manager (and the
/// sign-in autostart gets the first go). Windows has its own, shorter one
/// (`windows_sessions::SETTLE`).
#[cfg(any(target_os = "linux", test))]
pub const SETTLE: Duration = Duration::from_secs(30);
/// At most one start attempt per person in this long.
pub const RETRY: Duration = Duration::from_secs(60);

/// What a starter sees and does; tests use a fake.
pub trait Desktop {
    /// Whoever gets a helper: a person on Linux, a session on Windows.
    type Who: Clone + Eq + Hash;
    fn signed_in(&mut self) -> Vec<Self::Who>;
    /// Ends helpers of `who` that run another version, before the running
    /// check (Windows; Linux helpers follow the version link themselves).
    fn end_stale(&mut self, _who: &Self::Who) {}
    fn running(&mut self, who: &Self::Who) -> bool;
    fn start(&mut self, who: &Self::Who) -> Result<(), String>;
}

/// One start attempt, and whether its failure reason is new (logged as a
/// warning; a repeated reason is logged at debug).
#[derive(Debug, PartialEq, Eq)]
pub struct Attempt<W> {
    pub who: W,
    pub result: Result<(), String>,
    pub new_reason: bool,
}

/// When each person was first seen, last tried and last failed.
#[derive(Debug)]
pub struct Starter<W> {
    settle: Duration,
    first_seen: HashMap<W, Instant>,
    last_attempt: HashMap<W, Instant>,
    last_error: HashMap<W, String>,
}

impl<W: Clone + Eq + Hash> Starter<W> {
    /// A starter whose people wait `settle` before their first start.
    pub fn new(settle: Duration) -> Self {
        Self {
            settle,
            first_seen: HashMap::new(),
            last_attempt: HashMap::new(),
            last_error: HashMap::new(),
        }
    }

    /// One look at the desktop at `now`: starts the helper for each settled
    /// person without one, at most once per [`RETRY`].
    pub fn tick<D: Desktop<Who = W>>(&mut self, desktop: &mut D, now: Instant) -> Vec<Attempt<W>> {
        let present = desktop.signed_in();
        // Someone who signed out settles again when they come back.
        self.first_seen.retain(|who, _| present.contains(who));
        let mut attempts = Vec::new();
        for who in present {
            let seen = *self.first_seen.entry(who.clone()).or_insert(now);
            if now.saturating_duration_since(seen) < self.settle {
                continue;
            }
            desktop.end_stale(&who);
            if desktop.running(&who) {
                self.last_error.remove(&who);
                continue;
            }
            let recent = self
                .last_attempt
                .get(&who)
                .is_some_and(|at| now.saturating_duration_since(*at) < RETRY);
            if recent {
                continue;
            }
            self.last_attempt.insert(who.clone(), now);
            let result = desktop.start(&who);
            let new_reason = match &result {
                Ok(()) => {
                    self.last_error.remove(&who);
                    true
                }
                Err(reason) => {
                    self.last_error.insert(who.clone(), reason.clone()).as_ref() != Some(reason)
                }
            };
            attempts.push(Attempt {
                who,
                result,
                new_reason,
            });
        }
        attempts
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    /// Polled as often as the Linux starter looks.
    const POLL: Duration = Duration::from_secs(10);

    #[derive(Default)]
    struct FakeDesktop {
        people: Vec<u32>,
        running: HashSet<u32>,
        starts: Vec<u32>,
        fail_with: Option<String>,
        /// A started helper keeps running.
        stays_up: bool,
        /// Whose older helper still runs (and holds the session's mutex).
        stale: HashSet<u32>,
        /// Whose older helpers were ended, in order.
        ended: Vec<u32>,
    }

    impl Desktop for FakeDesktop {
        type Who = u32;
        fn signed_in(&mut self) -> Vec<u32> {
            self.people.clone()
        }
        fn end_stale(&mut self, who: &u32) {
            if self.stale.remove(who) {
                self.ended.push(*who);
            }
        }
        fn running(&mut self, who: &u32) -> bool {
            self.running.contains(who)
        }
        fn start(&mut self, who: &u32) -> Result<(), String> {
            self.starts.push(*who);
            if let Some(reason) = &self.fail_with {
                return Err(reason.clone());
            }
            if self.stale.contains(who) {
                return Err("an older helper holds the mutex".into());
            }
            if self.stays_up {
                self.running.insert(*who);
            }
            Ok(())
        }
    }

    /// SPEC-TRAY-SESSIONS TS3 (Linux and Windows).
    #[test]
    fn once_per_user() {
        let t0 = Instant::now();
        let mut fake = FakeDesktop {
            people: vec![1000, 1001],
            running: HashSet::from([1001]),
            stays_up: true,
            ..FakeDesktop::default()
        };
        let mut starter = Starter::new(SETTLE);
        assert!(starter.tick(&mut fake, t0).is_empty(), "nobody has settled");
        assert!(starter.tick(&mut fake, t0 + SETTLE / 2).is_empty());
        let attempts = starter.tick(&mut fake, t0 + SETTLE);
        assert_eq!(attempts.len(), 1);
        assert_eq!(attempts[0].who, 1000);
        assert_eq!(attempts[0].result, Ok(()));
        assert_eq!(fake.starts, [1000], "1001's helper already runs");
        for minutes in 1..10 {
            starter.tick(&mut fake, t0 + SETTLE + RETRY * minutes);
        }
        assert_eq!(
            fake.starts.len(),
            1,
            "a running helper is never started again"
        );

        // 1000 signs out and in again: the new session settles first.
        fake.people = vec![1001];
        fake.running.remove(&1000);
        let later = t0 + RETRY * 20;
        starter.tick(&mut fake, later);
        fake.people = vec![1000, 1001];
        assert!(starter.tick(&mut fake, later + POLL).is_empty());
        assert_eq!(starter.tick(&mut fake, later + POLL + SETTLE).len(), 1);
        assert_eq!(fake.starts.len(), 2);
    }

    /// SPEC-TRAY-SESSIONS TS4 (Linux and Windows).
    #[test]
    fn at_most_once_a_minute() {
        let t0 = Instant::now();
        let mut fake = FakeDesktop {
            people: vec![1000],
            fail_with: Some("Failed to connect to user bus".into()),
            ..FakeDesktop::default()
        };
        let mut starter = Starter::new(SETTLE);
        starter.tick(&mut fake, t0);
        let mut at = t0 + SETTLE;
        let first = starter.tick(&mut fake, at);
        assert!(first[0].new_reason, "the first failure is a warning");
        while at < t0 + SETTLE + RETRY * 3 {
            at += POLL;
            for attempt in starter.tick(&mut fake, at) {
                assert!(!attempt.new_reason, "the same reason is not warned again");
            }
        }
        assert_eq!(fake.starts.len(), 4, "one attempt a minute: {at:?}");

        // A helper that starts and exits is not restarted faster either.
        fake.fail_with = None;
        let mut exits = Starter::new(SETTLE);
        let mut starts = 0;
        let mut at = t0;
        while at <= t0 + SETTLE + RETRY * 2 {
            starts += exits.tick(&mut fake, at).len();
            at += POLL;
        }
        assert_eq!(starts, 3);

        // A changed reason is warned again.
        fake.fail_with = Some("Unit bmuster-tray.service already exists".into());
        let attempts = starter.tick(&mut fake, t0 + RETRY * 10);
        assert!(attempts[0].new_reason);
    }

    /// SPEC-TRAY-SESSIONS TS14.
    #[test]
    fn windows_starts_soon_after_sign_in() {
        use crate::tray::windows_sessions::{POLL as WINDOWS_POLL, SETTLE as WINDOWS_SETTLE};
        let t0 = Instant::now();
        let mut fake = FakeDesktop {
            people: vec![2],
            stays_up: true,
            ..FakeDesktop::default()
        };
        let mut starter = Starter::new(WINDOWS_SETTLE);
        let mut at = t0;
        let mut started_at = None;
        while at <= t0 + Duration::from_secs(30) && started_at.is_none() {
            if !starter.tick(&mut fake, at).is_empty() {
                started_at = Some(at);
            }
            at += WINDOWS_POLL;
        }
        let waited = started_at.map(|at| at - t0);
        assert!(
            waited.is_some_and(|waited| waited <= Duration::from_secs(7)),
            "started after {waited:?}"
        );

        // Linux keeps its 30 s: nothing at 7 s.
        let mut linux = Starter::new(SETTLE);
        let mut fake = FakeDesktop {
            people: vec![1000],
            ..FakeDesktop::default()
        };
        linux.tick(&mut fake, t0);
        assert!(linux
            .tick(&mut fake, t0 + Duration::from_secs(7))
            .is_empty());
        assert_eq!(SETTLE, Duration::from_secs(30));
    }

    /// SPEC-TRAY-SESSIONS TS18.
    #[test]
    fn stale_helpers_end_before_a_start() {
        let t0 = Instant::now();
        let mut fake = FakeDesktop {
            people: vec![1, 2],
            stale: HashSet::from([1]),
            stays_up: true,
            ..FakeDesktop::default()
        };
        let mut starter = Starter::new(SETTLE);
        starter.tick(&mut fake, t0);
        assert!(fake.ended.is_empty(), "nothing is ended before settling");
        let attempts = starter.tick(&mut fake, t0 + SETTLE);
        assert_eq!(fake.ended, [1], "only the session with an older helper");
        assert_eq!(attempts.len(), 2);
        assert!(
            attempts.iter().all(|attempt| attempt.result.is_ok()),
            "the current helper starts in the same pass: {attempts:?}"
        );
        // An older helper that appears later is ended, and the running
        // current one is left alone.
        fake.stale.insert(2);
        assert!(starter.tick(&mut fake, t0 + SETTLE + POLL).is_empty());
        assert_eq!(fake.ended, [1, 2]);
        assert_eq!(fake.starts, [1, 2]);
    }
}
