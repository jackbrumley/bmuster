//! When the agent starts a tray helper for someone (SPEC-TRAY-SESSIONS 4),
//! the same on Linux and Windows: each platform's starter says who is signed
//! in, whether their helper runs and how to start one; [`Starter`] decides
//! when. Someone must have been seen for [`SETTLE`] before their first start,
//! gets nothing while their helper runs, and gets at most one attempt in
//! [`RETRY`].

use std::collections::HashMap;
use std::hash::Hash;
use std::time::{Duration, Instant};

/// How long someone is seen before their first start, so their desktop is
/// ready (and the sign-in autostart gets the first go).
pub const SETTLE: Duration = Duration::from_secs(30);
/// At most one start attempt per person in this long.
pub const RETRY: Duration = Duration::from_secs(60);

/// What a starter sees and does; tests use a fake.
pub trait Desktop {
    /// Whoever gets a helper: a person on Linux, a session on Windows.
    type Who: Clone + Eq + Hash;
    fn signed_in(&mut self) -> Vec<Self::Who>;
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
    first_seen: HashMap<W, Instant>,
    last_attempt: HashMap<W, Instant>,
    last_error: HashMap<W, String>,
}

impl<W> Default for Starter<W> {
    fn default() -> Self {
        Self {
            first_seen: HashMap::new(),
            last_attempt: HashMap::new(),
            last_error: HashMap::new(),
        }
    }
}

impl<W: Clone + Eq + Hash> Starter<W> {
    /// One look at the desktop at `now`: starts the helper for each settled
    /// person without one, at most once per [`RETRY`].
    pub fn tick<D: Desktop<Who = W>>(&mut self, desktop: &mut D, now: Instant) -> Vec<Attempt<W>> {
        let present = desktop.signed_in();
        // Someone who signed out settles again when they come back.
        self.first_seen.retain(|who, _| present.contains(who));
        let mut attempts = Vec::new();
        for who in present {
            let seen = *self.first_seen.entry(who.clone()).or_insert(now);
            if now.saturating_duration_since(seen) < SETTLE {
                continue;
            }
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
    }

    impl Desktop for FakeDesktop {
        type Who = u32;
        fn signed_in(&mut self) -> Vec<u32> {
            self.people.clone()
        }
        fn running(&mut self, who: &u32) -> bool {
            self.running.contains(who)
        }
        fn start(&mut self, who: &u32) -> Result<(), String> {
            self.starts.push(*who);
            if let Some(reason) = &self.fail_with {
                return Err(reason.clone());
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
        let mut starter = Starter::default();
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
        let mut starter = Starter::default();
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
        let mut exits = Starter::default();
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
}
