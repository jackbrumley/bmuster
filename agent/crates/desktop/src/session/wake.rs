//! Waking the screen and keeping it awake for a control session
//! (SPEC-DESKTOP-WAKE). [`Wake`] decides when the session's [`Waker`]
//! nudges: at most every [`WAKE_EVERY`] while the look is dark, and while
//! the screen is open whenever nothing has reached the machine for
//! [`KEEP_AWAKE_EVERY`] (the first one [`SETTLE`] after opening). Viewer
//! input counts as something reaching the machine. Watch sessions never
//! have one.

use crate::follow::Waker;
use std::time::{Duration, Instant};

/// The shortest gap between nudges while the screen stays dark.
pub const WAKE_EVERY: Duration = Duration::from_secs(3);
/// Dark for this long: the screen may not wake (a closed lid).
pub const STAYS_OFF_AFTER: Duration = Duration::from_secs(10);
/// The longest the machine goes without input while a control session has
/// the screen open: shorter than any common idle timeout.
pub const KEEP_AWAKE_EVERY: Duration = Duration::from_secs(30);
/// The first keep-awake nudge after the screen opens.
pub const SETTLE: Duration = Duration::from_secs(2);

/// What the viewer reads while the agent wakes a dark screen.
pub const WAKING: &str = "The screen is off; waking it";
/// What the viewer reads when it stays dark past [`STAYS_OFF_AFTER`].
pub const STAYS_OFF: &str = "The screen stays off. If this is a laptop, its lid may be closed.";

pub(super) struct Wake {
    waker: Box<dyn Waker>,
    /// When the look went dark, while it is.
    dark_since: Option<Instant>,
    last_nudge: Option<Instant>,
    /// When the next keep-awake nudge is due, while the screen is open.
    keep_awake_at: Option<Instant>,
    /// A nudge failed; logged once until one works again.
    failing: bool,
}

impl Wake {
    pub(super) fn new(waker: Box<dyn Waker>) -> Self {
        Wake {
            waker,
            dark_since: None,
            last_nudge: None,
            keep_awake_at: None,
            failing: false,
        }
    }

    /// The look is dark: nudge unless one went in the last [`WAKE_EVERY`],
    /// and say what the viewer reads.
    pub(super) fn dark(&mut self, now: Instant) -> &'static str {
        self.keep_awake_at = None;
        let since = *self.dark_since.get_or_insert_with(|| {
            log::info!("The screen at the machine is off; waking it");
            now
        });
        let due = self
            .last_nudge
            .is_none_or(|at| now.saturating_duration_since(at) >= WAKE_EVERY);
        if due {
            self.nudge(now);
        }
        if now.saturating_duration_since(since) >= STAYS_OFF_AFTER {
            STAYS_OFF
        } else {
            WAKING
        }
    }

    /// The look is not dark.
    pub(super) fn lit(&mut self, now: Instant) {
        if let Some(since) = self.dark_since.take() {
            log::info!(
                "The screen at the machine came on after {} s",
                now.saturating_duration_since(since).as_secs()
            );
        }
    }

    /// The screen was opened: keep it awake from now on.
    pub(super) fn opened(&mut self, now: Instant) {
        self.keep_awake_at = Some(now + SETTLE);
    }

    /// The screen was closed: nothing to keep awake until it opens again.
    pub(super) fn closed(&mut self) {
        self.keep_awake_at = None;
    }

    /// Capture failed in a control session: the display may have gone off.
    pub(super) fn lost(&mut self, now: Instant) {
        self.keep_awake_at = None;
        let due = self
            .last_nudge
            .is_none_or(|at| now.saturating_duration_since(at) >= WAKE_EVERY);
        if due {
            self.nudge(now);
        }
    }

    /// The viewer's input reached the machine: no nudge needed for a while.
    pub(super) fn viewer_input(&mut self, now: Instant) {
        if let Some(at) = self.keep_awake_at.as_mut() {
            *at = (*at).max(now + KEEP_AWAKE_EVERY);
        }
    }

    /// While the screen is open: nudge when it is time.
    pub(super) fn keep_awake(&mut self, now: Instant) {
        if self.keep_awake_at.is_some_and(|at| now >= at) {
            self.nudge(now);
            self.keep_awake_at = Some(now + KEEP_AWAKE_EVERY);
        }
    }

    fn nudge(&mut self, now: Instant) {
        self.last_nudge = Some(now);
        match self.waker.nudge() {
            Ok(()) => self.failing = false,
            Err(error) => {
                if !std::mem::replace(&mut self.failing, true) {
                    log::warn!("Could not wake the screen at the machine: {error}");
                }
            }
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;

    /// Counts nudges; shared so a test can read it after handing it over.
    #[derive(Clone, Default)]
    pub(crate) struct CountingWaker(pub(crate) Arc<AtomicU32>);

    impl CountingWaker {
        pub(crate) fn take(&self) -> u32 {
            self.0.swap(0, Ordering::SeqCst)
        }
    }

    impl Waker for CountingWaker {
        fn nudge(&mut self) -> Result<(), String> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Ok(())
        }
    }

    fn secs(n: u64) -> Duration {
        Duration::from_secs(n)
    }

    /// SPEC-DESKTOP-WAKE W3.
    #[test]
    fn wake_is_rate_limited_and_says_the_lid() {
        let waker = CountingWaker::default();
        let mut wake = Wake::new(Box::new(waker.clone()));
        let t0 = Instant::now();
        assert_eq!(wake.dark(t0), WAKING);
        assert_eq!(waker.take(), 1, "the first dark look nudges at once");
        assert_eq!(wake.dark(t0 + secs(1)), WAKING);
        assert_eq!(wake.dark(t0 + secs(2)), WAKING);
        assert_eq!(waker.take(), 0, "not again within 3 s");
        wake.dark(t0 + secs(3));
        assert_eq!(waker.take(), 1);
        for s in 4..10 {
            assert_eq!(wake.dark(t0 + secs(s)), WAKING);
        }
        assert_eq!(waker.take(), 2, "at 6 s and 9 s");
        assert_eq!(wake.dark(t0 + secs(10)), STAYS_OFF);

        // Lit again: a later dark spell starts its own count.
        wake.lit(t0 + secs(11));
        assert_eq!(wake.dark(t0 + secs(20)), WAKING);
        assert_eq!(waker.take(), 1);
    }

    /// SPEC-DESKTOP-WAKE W4.
    #[test]
    fn keep_awake_cadence_and_viewer_input() {
        let waker = CountingWaker::default();
        let mut wake = Wake::new(Box::new(waker.clone()));
        let t0 = Instant::now();
        wake.keep_awake(t0 + secs(60));
        assert_eq!(waker.take(), 0, "nothing before the screen opens");

        wake.opened(t0);
        wake.keep_awake(t0 + secs(1));
        assert_eq!(waker.take(), 0);
        wake.keep_awake(t0 + secs(2));
        assert_eq!(waker.take(), 1, "2 s after opening");
        wake.keep_awake(t0 + secs(31));
        assert_eq!(waker.take(), 0);
        wake.keep_awake(t0 + secs(32));
        assert_eq!(waker.take(), 1, "30 s later");

        // The viewer types at 50 s: the next nudge waits until 80 s.
        wake.viewer_input(t0 + secs(50));
        wake.keep_awake(t0 + secs(62));
        wake.keep_awake(t0 + secs(79));
        assert_eq!(waker.take(), 0);
        wake.keep_awake(t0 + secs(80));
        assert_eq!(waker.take(), 1);

        // Closed: no more.
        wake.closed();
        wake.keep_awake(t0 + secs(200));
        assert_eq!(waker.take(), 0);
        wake.viewer_input(t0 + secs(201));
        wake.keep_awake(t0 + secs(400));
        assert_eq!(waker.take(), 0, "input does not restart it either");
    }

    #[test]
    fn a_failing_waker_never_stops_the_session() {
        struct Broken;
        impl Waker for Broken {
            fn nudge(&mut self) -> Result<(), String> {
                Err("uinput write failed".into())
            }
        }
        let mut wake = Wake::new(Box::new(Broken));
        let t0 = Instant::now();
        assert_eq!(wake.dark(t0), WAKING);
        assert!(wake.failing);
        assert_eq!(wake.dark(t0 + secs(12)), STAYS_OFF);
    }
}
