//! Auto quality, version 2 (SPEC-DESKTOP 20): the highest level the link
//! sustains.
//!
//! A pure state machine with the clock passed in. It judges the link once a
//! second from the acknowledgement round trips: how far the frames' delay
//! sits above the smallest delay seen in the last minute (the link's own
//! latency) is the backlog the picture adds. A second with frames delivered
//! and little backlog is *clear*; a second with a lot is *strained*.
//!
//! - **Up** one level after [`UP_AFTER_SECS`] clear seconds in a row, or
//!   longer to a level the link failed at lately (the hysteresis).
//! - **Down** one level after [`DOWN_AFTER_SECS`] strained seconds in a row,
//!   but below Medium only after [`FLOOR_AFTER_SECS`]: a really poor link.
//! - Seconds with no frames (a still screen) change nothing.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

/// The levels Auto moves between, lowest first; the same JPEG qualities as
/// the fixed settings of the same name.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, serde::Serialize, serde::Deserialize,
)]
#[serde(rename_all = "kebab-case")]
pub enum Level {
    Low,
    Medium,
    High,
    ExtraHigh,
}

impl Level {
    const ALL: [Level; 4] = [Level::Low, Level::Medium, Level::High, Level::ExtraHigh];

    pub fn jpeg(self) -> u8 {
        match self {
            Level::Low => 40,
            Level::Medium => 65,
            Level::High => 90,
            Level::ExtraHigh => 95,
        }
    }

    fn index(self) -> usize {
        self as usize
    }

    fn up(self) -> Option<Level> {
        Level::ALL.get(self.index() + 1).copied()
    }

    fn down(self) -> Option<Level> {
        self.index().checked_sub(1).map(|i| Level::ALL[i])
    }
}

/// Where Auto starts unless the viewer says the last session sustained more.
pub const START: Level = Level::High;
/// Backlog under this, with frames delivered, makes a clear second.
pub const CLEAR_BACKLOG: Duration = Duration::from_millis(150);
/// Backlog over this makes a strained second.
pub const STRAIN_BACKLOG: Duration = Duration::from_millis(300);
/// Clear seconds in a row before a step up.
pub const UP_AFTER_SECS: u32 = 3;
/// Strained seconds in a row before a step down.
pub const DOWN_AFTER_SECS: u32 = 2;
/// Strained seconds in a row at Medium before Low.
pub const FLOOR_AFTER_SECS: u32 = 5;
/// Clear seconds needed to climb back to a level the link just failed at;
/// doubles on each further failure up to [`MAX_PENALTY_SECS`].
pub const FIRST_PENALTY_SECS: u32 = 15;
pub const MAX_PENALTY_SECS: u32 = 60;
/// A level held this long without a step down is trusted again.
pub const FORGIVE_AFTER: Duration = Duration::from_secs(60);
/// How far back the link's own latency (the smallest delay) is looked for.
const BASE_WINDOW_SECS: usize = 60;
const SECOND: Duration = Duration::from_secs(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Verdict {
    Clear,
    Strained,
    /// Some backlog, but not much: no step either way, and no clear run.
    Between,
    /// No frames: nothing learnt.
    Idle,
}

#[derive(Debug)]
pub struct AutoQuality {
    level: Level,
    /// Since when the level has held.
    held_since: Instant,
    second_start: Instant,
    /// Round trips acknowledged in the current second.
    samples: Duration,
    sample_count: u32,
    smallest_this_second: Option<Duration>,
    /// The smallest delay of each of the last [`BASE_WINDOW_SECS`] seconds.
    smallest: VecDeque<Duration>,
    clear_run: u32,
    strained_run: u32,
    /// Clear seconds needed to climb to each level, after it failed.
    penalty: [u32; 4],
}

impl AutoQuality {
    pub fn new(start: Level, now: Instant) -> Self {
        AutoQuality {
            level: start,
            held_since: now,
            second_start: now,
            samples: Duration::ZERO,
            sample_count: 0,
            smallest_this_second: None,
            smallest: VecDeque::new(),
            clear_run: 0,
            strained_run: 0,
            penalty: [0; 4],
        }
    }

    pub fn level(&self) -> Level {
        self.level
    }

    /// A frame's round trip, from sending it to its acknowledgement.
    pub fn frame_acked(&mut self, round_trip: Duration) {
        self.samples += round_trip;
        self.sample_count += 1;
        self.smallest_this_second = Some(
            self.smallest_this_second
                .map_or(round_trip, |s| s.min(round_trip)),
        );
    }

    /// Call on every capture tick, with when the oldest frame still waiting
    /// for its acknowledgement was sent. Returns the new level when it
    /// changes.
    pub fn tick(&mut self, now: Instant, oldest_unacked: Option<Instant>) -> Option<Level> {
        if now.saturating_duration_since(self.second_start) < SECOND {
            return None;
        }
        let verdict = self.close_second(now, oldest_unacked);
        self.second_start = now;
        self.decide(verdict, now)
    }

    fn close_second(&mut self, now: Instant, oldest_unacked: Option<Instant>) -> Verdict {
        let waiting = oldest_unacked.map(|sent| now.saturating_duration_since(sent));
        let mean = (self.sample_count > 0).then(|| self.samples / self.sample_count);
        let delivered = self.sample_count > 0;
        if let Some(smallest) = self.smallest_this_second.take() {
            if self.smallest.len() == BASE_WINDOW_SECS {
                self.smallest.pop_front();
            }
            self.smallest.push_back(smallest);
        }
        self.samples = Duration::ZERO;
        self.sample_count = 0;

        // A frame stuck in flight is delay too, even before its ack comes.
        let delay = match (mean, waiting) {
            (Some(mean), Some(waiting)) => mean.max(waiting),
            (Some(delay), None) | (None, Some(delay)) => delay,
            (None, None) => return Verdict::Idle,
        };
        let base = self.smallest.iter().min().copied().unwrap_or(delay);
        let backlog = delay.saturating_sub(base);
        if backlog > STRAIN_BACKLOG {
            Verdict::Strained
        } else if delivered && backlog < CLEAR_BACKLOG {
            Verdict::Clear
        } else if delivered {
            Verdict::Between
        } else {
            Verdict::Idle
        }
    }

    fn decide(&mut self, verdict: Verdict, now: Instant) -> Option<Level> {
        if now.saturating_duration_since(self.held_since) >= FORGIVE_AFTER {
            self.penalty[self.level.index()] = 0;
        }
        match verdict {
            Verdict::Idle => return None,
            Verdict::Between => {
                self.clear_run = 0;
                self.strained_run = 0;
                return None;
            }
            Verdict::Clear => {
                self.strained_run = 0;
                self.clear_run += 1;
            }
            Verdict::Strained => {
                self.clear_run = 0;
                self.strained_run += 1;
            }
        }
        if let Some(lower) = self.level.down() {
            let needed = if lower < Level::Medium {
                FLOOR_AFTER_SECS
            } else {
                DOWN_AFTER_SECS
            };
            if self.strained_run >= needed {
                let failed = &mut self.penalty[self.level.index()];
                *failed = (*failed * 2).clamp(FIRST_PENALTY_SECS, MAX_PENALTY_SECS);
                return Some(self.change(lower, now));
            }
        }
        if let Some(higher) = self.level.up() {
            if self.clear_run >= UP_AFTER_SECS.max(self.penalty[higher.index()]) {
                return Some(self.change(higher, now));
            }
        }
        None
    }

    fn change(&mut self, level: Level, now: Instant) -> Level {
        self.level = level;
        self.held_since = now;
        self.clear_run = 0;
        self.strained_run = 0;
        level
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    /// Runs `seconds` of a 10 fps stream whose frames take `round_trip`,
    /// ticking every 100 ms; returns each change of level.
    fn run(
        auto: &mut AutoQuality,
        now: &mut Instant,
        seconds: u64,
        round_trip: Duration,
    ) -> Vec<Level> {
        let mut changes = Vec::new();
        for _ in 0..seconds * 10 {
            *now += ms(100);
            auto.frame_acked(round_trip);
            changes.extend(auto.tick(*now, None));
        }
        changes
    }

    /// A link with 40 ms of its own latency: frames come back at once.
    const GOOD: Duration = Duration::from_millis(50);
    /// The same link with frames queueing: half a second of backlog.
    const CONGESTED: Duration = Duration::from_millis(600);

    #[test]
    fn auto_good_link_climbs_to_extra_high_within_a_few_seconds() {
        let mut now = Instant::now();
        let mut auto = AutoQuality::new(START, now);
        assert_eq!(auto.level(), Level::High);
        assert_eq!(run(&mut auto, &mut now, 2, GOOD), []);
        assert_eq!(run(&mut auto, &mut now, 2, GOOD), [Level::ExtraHigh]);
        // And stays there.
        assert_eq!(run(&mut auto, &mut now, 60, GOOD), []);

        let mut auto = AutoQuality::new(Level::Low, now);
        assert_eq!(
            run(&mut auto, &mut now, 10, GOOD),
            [Level::Medium, Level::High, Level::ExtraHigh]
        );
    }

    #[test]
    fn auto_congestion_steps_down_promptly_and_not_below_medium_unless_really_poor() {
        let mut now = Instant::now();
        let mut auto = AutoQuality::new(Level::ExtraHigh, now);
        run(&mut auto, &mut now, 3, GOOD);
        assert_eq!(run(&mut auto, &mut now, 2, CONGESTED), [Level::High]);
        assert_eq!(run(&mut auto, &mut now, 2, CONGESTED), [Level::Medium]);
        // Medium holds through a few more bad seconds...
        assert_eq!(run(&mut auto, &mut now, 4, CONGESTED), []);
        // ...and gives way to Low only when the link stays really poor.
        assert_eq!(run(&mut auto, &mut now, 1, CONGESTED), [Level::Low]);
        assert_eq!(run(&mut auto, &mut now, 10, CONGESTED), []);
    }

    #[test]
    fn auto_a_frame_stuck_in_flight_counts_as_backlog() {
        let mut now = Instant::now();
        let mut auto = AutoQuality::new(Level::ExtraHigh, now);
        run(&mut auto, &mut now, 2, GOOD);
        // Nothing is acknowledged any more; the oldest frame waits on.
        let sent = now;
        let mut changes = Vec::new();
        for _ in 0..20 {
            now += ms(100);
            changes.extend(auto.tick(now, Some(sent)));
        }
        assert_eq!(changes, [Level::High]);
    }

    #[test]
    fn auto_one_slow_second_such_as_a_big_keyframe_changes_nothing() {
        let mut now = Instant::now();
        let mut auto = AutoQuality::new(Level::ExtraHigh, now);
        run(&mut auto, &mut now, 3, GOOD);
        assert_eq!(run(&mut auto, &mut now, 1, CONGESTED), []);
        assert_eq!(run(&mut auto, &mut now, 1, GOOD), []);
        assert_eq!(run(&mut auto, &mut now, 1, CONGESTED), []);
        assert_eq!(auto.level(), Level::ExtraHigh);
    }

    #[test]
    fn auto_recovery_climbs_back_with_hysteresis() {
        let mut now = Instant::now();
        let mut auto = AutoQuality::new(Level::ExtraHigh, now);
        run(&mut auto, &mut now, 3, GOOD);
        assert_eq!(run(&mut auto, &mut now, 2, CONGESTED), [Level::High]);
        // Extra high just failed: 3 clear seconds are not enough to go back.
        assert_eq!(run(&mut auto, &mut now, 14, GOOD), []);
        assert_eq!(run(&mut auto, &mut now, 1, GOOD), [Level::ExtraHigh]);
        // It fails again at once: the wait doubles.
        assert_eq!(run(&mut auto, &mut now, 2, CONGESTED), [Level::High]);
        assert_eq!(run(&mut auto, &mut now, 29, GOOD), []);
        assert_eq!(run(&mut auto, &mut now, 1, GOOD), [Level::ExtraHigh]);
        // Held for a minute, Extra high is trusted again: a later dip
        // climbs back after the first penalty, not a longer one.
        assert_eq!(run(&mut auto, &mut now, 61, GOOD), []);
        assert_eq!(run(&mut auto, &mut now, 2, CONGESTED), [Level::High]);
        assert_eq!(run(&mut auto, &mut now, 14, GOOD), []);
        assert_eq!(run(&mut auto, &mut now, 1, GOOD), [Level::ExtraHigh]);
    }

    #[test]
    fn auto_a_still_screen_changes_nothing() {
        let mut now = Instant::now();
        let mut auto = AutoQuality::new(START, now);
        for _ in 0..600 {
            now += ms(100);
            assert_eq!(auto.tick(now, None), None);
        }
        assert_eq!(auto.level(), Level::High);
    }

    #[test]
    fn auto_remembered_start_begins_at_extra_high() {
        let now = Instant::now();
        let auto = AutoQuality::new(Level::ExtraHigh, now);
        assert_eq!(auto.level(), Level::ExtraHigh);
        assert_eq!(auto.level().jpeg(), 95);
    }

    #[test]
    fn auto_levels_serialise_as_the_settings_names() {
        assert_eq!(
            serde_json::to_string(&Level::ExtraHigh).unwrap(),
            r#""extra-high""#
        );
        assert_eq!(
            serde_json::from_str::<Level>(r#""medium""#).unwrap(),
            Level::Medium
        );
    }
}
