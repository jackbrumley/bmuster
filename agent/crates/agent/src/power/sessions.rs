//! No idle sleep while a remote session is open (SPEC-DESKTOP-WAKE), so a
//! viewer is never cut off by the machine's sleep timer, whatever the
//! per-machine Stay awake setting says.
//!
//! Every session thread holds a [`SessionHold`] ([`hold`]) for its whole
//! run; the count of live holds is [`open`]. The stay-awake thread's
//! [`SessionKeeper`] takes a second inhibitor (its own why) while the count
//! is above zero and lets go when it reaches zero. A hold is a guard, so a
//! session that fails or panics still lets go. Like Stay awake it holds off
//! idle sleep only: the lid, the power button and Sleep or Shut down from
//! the menu still work.

use super::Inhibit;
use std::sync::atomic::{AtomicUsize, Ordering};

static OPEN: AtomicUsize = AtomicUsize::new(0);

/// Remote sessions open now.
pub fn open() -> usize {
    OPEN.load(Ordering::Acquire)
}

/// One open session's claim; dropping it lets go.
#[derive(Debug)]
pub struct SessionHold(());

/// Counts one more open session and tells the stay-awake thread.
pub fn hold() -> SessionHold {
    OPEN.fetch_add(1, Ordering::AcqRel);
    super::sessions_changed();
    SessionHold(())
}

impl Drop for SessionHold {
    fn drop(&mut self) {
        OPEN.fetch_sub(1, Ordering::AcqRel);
        super::sessions_changed();
    }
}

/// Holds its inhibitor exactly while a session is open.
pub struct SessionKeeper<I: Inhibit> {
    inhibit: I,
    held: Option<I::Lock>,
    /// The last failure, logged once.
    failure: Option<String>,
}

impl<I: Inhibit> SessionKeeper<I> {
    pub fn new(inhibit: I) -> Self {
        Self {
            inhibit,
            held: None,
            failure: None,
        }
    }

    #[cfg(test)]
    pub fn is_held(&self) -> bool {
        self.held.is_some()
    }

    /// Takes or releases the inhibitor for `open` sessions. A failure is
    /// tried again on the next call.
    pub fn apply(&mut self, open: usize) {
        if open == 0 {
            if self.held.take().is_some() {
                log::info!("No remote session is open, so the machine sleeps normally again.");
            }
            self.failure = None;
            return;
        }
        if self.held.is_some() {
            return;
        }
        match self.inhibit.take() {
            Ok(lock) => {
                log::info!("A remote session is open, so automatic sleep is held off.");
                self.held = Some(lock);
                self.failure = None;
            }
            Err(reason) => {
                if self.failure.as_deref() != Some(reason.as_str()) {
                    log::warn!(
                        "Could not hold off automatic sleep while a session is open: {reason}"
                    );
                }
                self.failure = Some(reason);
            }
        }
    }

    /// Lets go (the agent is stopping).
    pub fn release(&mut self) {
        if self.held.take().is_some() {
            log::info!("The remote session sleep hold is released while the agent stops.");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::tests::FakeInhibitor;
    use super::*;
    use std::sync::Mutex;

    /// The count is global: one test at a time touches it.
    static TURN: Mutex<()> = Mutex::new(());

    /// SPEC-DESKTOP-WAKE W8.
    #[test]
    fn remote_sessions_hold_off_idle_sleep() {
        let fake = FakeInhibitor::default();
        let mut keeper = SessionKeeper::new(fake.clone());
        keeper.apply(0);
        assert_eq!(fake.state.borrow().taken, 0, "nothing while none is open");

        keeper.apply(1);
        assert!(keeper.is_held(), "taken on the first open session");
        keeper.apply(3);
        keeper.apply(2);
        keeper.apply(1);
        assert_eq!(fake.state.borrow().taken, 1, "kept while any is open");
        assert_eq!(fake.state.borrow().live, 1);
        keeper.apply(0);
        assert_eq!(fake.state.borrow().live, 0, "released on the last end");

        // A refusal is tried again until it works.
        fake.state.borrow_mut().fail_with = Some("Access denied".into());
        keeper.apply(1);
        assert!(!keeper.is_held());
        fake.state.borrow_mut().fail_with = None;
        keeper.apply(1);
        assert!(keeper.is_held());
        keeper.release();
        assert_eq!(fake.state.borrow().live, 0, "released when the agent stops");
    }

    /// SPEC-DESKTOP-WAKE W9.
    #[test]
    fn session_guards_count_and_never_leak() {
        let _turn = TURN.lock().unwrap_or_else(|p| p.into_inner());
        let before = open();
        let first = hold();
        let second = hold();
        assert_eq!(open(), before + 2, "overlapping sessions both count");
        drop(first);
        assert_eq!(open(), before + 1);
        let crashed = std::thread::spawn(|| {
            let _hold = hold();
            panic!("a session thread fails");
        })
        .join();
        assert!(crashed.is_err());
        assert_eq!(open(), before + 1, "a panicking session lets go");
        drop(second);
        assert_eq!(open(), before);
    }
}
