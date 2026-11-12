//! Pacing: the ack window, the frame rate, keyframe requests, the stall
//! guard, and feeding Auto quality ([`crate::auto_quality`]) its round
//! trips (SPEC-DESKTOP 4.3, R5, section 20).
//!
//! A pure state machine: every method takes the current time, so the tests
//! drive it with a made-up clock. The session asks [`Pacer::tick`] on each
//! capture tick and only captures and encodes when it says so. Frames are
//! dropped before encoding, never after: a skipped tick costs nothing,
//! because the capturer keeps adding up the damage for the next frame.

use crate::auto_quality::{AutoQuality, Level};
use std::collections::VecDeque;
use std::time::{Duration, Instant};

/// Unacknowledged frames allowed in flight.
pub const WINDOW: usize = 2;
/// The window when the measured round trip is slow.
pub const SLOW_WINDOW: usize = 3;
/// Round trip above which [`SLOW_WINDOW`] applies.
pub const SLOW_ROUND_TRIP: Duration = Duration::from_millis(150);
/// No ack for this long with frames in flight: stop and send `stalled`.
pub const STALL_AFTER: Duration = Duration::from_secs(10);
/// Keyframe requests closer together than this are ignored.
pub const KEYFRAME_REPEAT: Duration = Duration::from_millis(500);
/// The `quality` setting.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Quality {
    Auto,
    Low,
    Medium,
    High,
    /// Close to native for text and UI (SPEC-DESKTOP R10, version 2).
    ExtraHigh,
}

impl Quality {
    fn fixed(self) -> Option<Level> {
        match self {
            Quality::Auto => None,
            Quality::Low => Some(Level::Low),
            Quality::Medium => Some(Level::Medium),
            Quality::High => Some(Level::High),
            Quality::ExtraHigh => Some(Level::ExtraHigh),
        }
    }
}

/// What to do on a capture tick.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TickDecision {
    /// Capture and encode; a keyframe when `keyframe` is set.
    Capture { keyframe: bool },
    /// The window is full: skip this tick.
    WindowFull,
    /// No ack for [`STALL_AFTER`]. `newly` is true the first time, when the
    /// session sends `{type: 'stalled'}`.
    Stalled { newly: bool },
}

/// True when `seq` is at or before `ack`, allowing for wrap-around.
pub fn seq_at_or_before(seq: u32, ack: u32) -> bool {
    ack.wrapping_sub(seq) < 0x8000_0000
}

#[derive(Debug)]
pub struct Pacer {
    in_flight: VecDeque<(u32, Instant)>,
    round_trip: Option<Duration>,
    stalled: bool,
    keyframe_wanted: bool,
    last_keyframe_request: Option<Instant>,
    frame_interval: Duration,
    next_capture: Instant,
    /// A tick was skipped for a full window since the last capture.
    missed_tick: bool,
    quality: Quality,
    /// The viewer has sent its first `settings`.
    quality_set: bool,
    auto: AutoQuality,
    /// Auto's level changed (or was set) and the viewer has not been told.
    auto_untold: bool,
}

impl Pacer {
    pub fn new(now: Instant, max_fps: u32) -> Self {
        Pacer {
            in_flight: VecDeque::new(),
            round_trip: None,
            stalled: false,
            keyframe_wanted: true,
            last_keyframe_request: None,
            frame_interval: interval_for(max_fps),
            next_capture: now,
            missed_tick: false,
            quality: Quality::Auto,
            quality_set: false,
            auto: AutoQuality::new(crate::auto_quality::START, now),
            auto_untold: false,
        }
    }

    /// Frames allowed in flight now.
    pub fn window(&self) -> usize {
        match self.round_trip {
            Some(rtt) if rtt > SLOW_ROUND_TRIP => SLOW_WINDOW,
            _ => WINDOW,
        }
    }

    pub fn round_trip(&self) -> Option<Duration> {
        self.round_trip
    }

    pub fn in_flight(&self) -> usize {
        self.in_flight.len()
    }

    pub fn is_stalled(&self) -> bool {
        self.stalled
    }

    pub fn set_max_fps(&mut self, max_fps: u32) {
        self.frame_interval = interval_for(max_fps);
    }

    pub fn frame_interval(&self) -> Duration {
        self.frame_interval
    }

    /// When the session should call [`Pacer::tick`] next.
    pub fn next_tick(&self) -> Instant {
        self.next_capture
    }

    /// JPEG quality for the next frame.
    pub fn jpeg_quality(&self) -> u8 {
        self.quality.fixed().unwrap_or(self.auto.level()).jpeg()
    }

    /// The level Auto is at, while quality is on Auto.
    pub fn auto_level(&self) -> Option<Level> {
        (self.quality == Quality::Auto).then(|| self.auto.level())
    }

    /// The level Auto is at, once after each change (and after
    /// [`Pacer::set_quality`] turns Auto on), for the viewer to show.
    pub fn take_auto_news(&mut self) -> Option<Level> {
        if !std::mem::take(&mut self.auto_untold) {
            return None;
        }
        self.auto_level()
    }

    /// Applies the `quality` setting; `auto_start` is where Auto starts
    /// (the level the viewer's last session sustained). Returns true when
    /// the quality changed, which calls for a keyframe so every tile shows
    /// it. The first call always applies, so Auto starts at `auto_start`.
    /// After that, Auto staying Auto keeps its level: a `settings` message
    /// that changes only the scale, or a new page's greeting, starts
    /// nothing over.
    pub fn set_quality(&mut self, quality: Quality, auto_start: Level, now: Instant) -> bool {
        self.auto_untold = true;
        if self.quality_set && quality == self.quality {
            return false;
        }
        self.quality_set = true;
        self.quality = quality;
        self.auto = AutoQuality::new(auto_start, now);
        self.keyframe_wanted = true;
        true
    }

    /// A keyframe for the session's own reasons (start, display switch,
    /// resize): never rate-limited.
    pub fn force_keyframe(&mut self) {
        self.keyframe_wanted = true;
    }

    /// The browser asked for a keyframe. Repeats within [`KEYFRAME_REPEAT`]
    /// are ignored (returns false). An accepted request also ends a stall
    /// and forgets frames in flight, since the browser has dropped them.
    pub fn request_keyframe(&mut self, now: Instant) -> bool {
        if let Some(last) = self.last_keyframe_request {
            if now.saturating_duration_since(last) < KEYFRAME_REPEAT {
                return false;
            }
        }
        self.last_keyframe_request = Some(now);
        self.resume(now);
        true
    }

    fn resume(&mut self, now: Instant) {
        self.stalled = false;
        self.keyframe_wanted = true;
        self.in_flight.clear();
        self.next_capture = self.next_capture.min(now);
    }

    /// Decides one capture tick. Call it when [`Pacer::next_tick`] is due.
    pub fn tick(&mut self, now: Instant) -> TickDecision {
        self.next_capture = now + self.frame_interval;
        if self.quality == Quality::Auto {
            let oldest = self.in_flight.front().map(|&(_, sent)| sent);
            let before = self.auto.level();
            if let Some(level) = self.auto.tick(now, oldest) {
                self.auto_untold = true;
                // A step up shows on every tile, so a still screen's text
                // sharpens too; a step down waits for tiles to change,
                // since the link is short of room.
                if level > before {
                    self.keyframe_wanted = true;
                }
            }
        }

        if let Some(&(_, oldest)) = self.in_flight.front() {
            if !self.stalled && now.saturating_duration_since(oldest) >= STALL_AFTER {
                self.stalled = true;
                return TickDecision::Stalled { newly: true };
            }
        }
        if self.stalled {
            return TickDecision::Stalled { newly: false };
        }

        if self.in_flight.len() >= self.window() {
            self.missed_tick = true;
            return TickDecision::WindowFull;
        }

        self.missed_tick = false;
        TickDecision::Capture {
            keyframe: self.keyframe_wanted,
        }
    }

    /// A frame went out (all its batches).
    pub fn sent(&mut self, seq: u32, now: Instant, keyframe: bool) {
        self.in_flight.push_back((seq, now));
        if keyframe {
            self.keyframe_wanted = false;
        }
    }

    /// The browser drew everything up to `seq`. Acks are cumulative; a stale
    /// one changes nothing. Ends a stall (with a keyframe next). Returns true
    /// when the session should capture at once because a tick was skipped
    /// for a full window.
    pub fn ack(&mut self, seq: u32, now: Instant) -> bool {
        let mut sample = None;
        while let Some(&(sent_seq, sent_at)) = self.in_flight.front() {
            if !seq_at_or_before(sent_seq, seq) {
                break;
            }
            if sent_seq == seq {
                sample = Some(now.saturating_duration_since(sent_at));
            }
            self.in_flight.pop_front();
        }
        if let Some(sample) = sample {
            self.auto.frame_acked(sample);
            self.round_trip = Some(match self.round_trip {
                // Smoothed like TCP's SRTT: 7/8 old, 1/8 new.
                Some(old) => (old * 7 + sample) / 8,
                None => sample,
            });
        }
        if self.stalled {
            self.resume(now);
            return true;
        }
        if self.missed_tick && self.in_flight.len() < self.window() {
            self.next_capture = self.next_capture.min(now);
            return true;
        }
        false
    }
}

fn interval_for(max_fps: u32) -> Duration {
    Duration::from_secs(1) / max_fps.clamp(1, 60)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    /// Ticks once and, when it says capture, "sends" a frame.
    fn step(pacer: &mut Pacer, seq: &mut u32, now: Instant) -> TickDecision {
        let decision = pacer.tick(now);
        if let TickDecision::Capture { keyframe } = decision {
            *seq += 1;
            pacer.sent(*seq, now, keyframe);
        }
        decision
    }

    #[test]
    fn pacing_window_of_two_skips_ticks_before_encoding() {
        let t0 = Instant::now();
        let mut pacer = Pacer::new(t0, 15);
        let mut seq = 0;
        assert_eq!(
            step(&mut pacer, &mut seq, t0),
            TickDecision::Capture { keyframe: true }
        );
        assert_eq!(
            step(&mut pacer, &mut seq, t0 + ms(66)),
            TickDecision::Capture { keyframe: false }
        );
        assert_eq!(
            step(&mut pacer, &mut seq, t0 + ms(133)),
            TickDecision::WindowFull
        );
        assert_eq!(pacer.in_flight(), 2);
        // Acking the first frame opens one slot and asks for a capture now.
        assert!(pacer.ack(1, t0 + ms(140)));
        assert_eq!(pacer.next_tick(), t0 + ms(140));
        assert_eq!(
            step(&mut pacer, &mut seq, t0 + ms(140)),
            TickDecision::Capture { keyframe: false }
        );
    }

    #[test]
    fn pacing_acks_are_cumulative_and_stale_acks_change_nothing() {
        let t0 = Instant::now();
        let mut pacer = Pacer::new(t0, 30);
        pacer.sent(1, t0, true);
        pacer.sent(2, t0, false);
        pacer.ack(2, t0 + ms(20));
        assert_eq!(pacer.in_flight(), 0);
        pacer.sent(3, t0 + ms(30), false);
        pacer.ack(1, t0 + ms(40));
        assert_eq!(pacer.in_flight(), 1);
    }

    #[test]
    fn pacing_seq_comparison_wraps() {
        assert!(seq_at_or_before(u32::MAX, 1));
        assert!(seq_at_or_before(5, 5));
        assert!(!seq_at_or_before(2, 1));
        assert!(!seq_at_or_before(1, u32::MAX));
    }

    #[test]
    fn pacing_slow_round_trip_widens_the_window_to_three() {
        let t0 = Instant::now();
        let mut pacer = Pacer::new(t0, 15);
        assert_eq!(pacer.window(), WINDOW);
        pacer.sent(1, t0, true);
        pacer.ack(1, t0 + ms(400));
        assert_eq!(pacer.round_trip(), Some(ms(400)));
        assert_eq!(pacer.window(), SLOW_WINDOW);
    }

    #[test]
    fn pacing_stall_after_ten_seconds_then_ack_resumes_with_keyframe() {
        let t0 = Instant::now();
        let mut pacer = Pacer::new(t0, 15);
        let mut seq = 0;
        step(&mut pacer, &mut seq, t0);
        step(&mut pacer, &mut seq, t0 + ms(100));
        assert_eq!(
            step(&mut pacer, &mut seq, t0 + ms(9_999)),
            TickDecision::WindowFull
        );
        assert_eq!(
            step(&mut pacer, &mut seq, t0 + ms(10_000)),
            TickDecision::Stalled { newly: true }
        );
        assert_eq!(
            step(&mut pacer, &mut seq, t0 + ms(10_100)),
            TickDecision::Stalled { newly: false }
        );
        assert!(pacer.ack(1, t0 + ms(11_000)));
        assert!(!pacer.is_stalled());
        assert_eq!(
            step(&mut pacer, &mut seq, t0 + ms(11_000)),
            TickDecision::Capture { keyframe: true }
        );
    }

    #[test]
    fn pacing_keyframe_request_resumes_a_stall_and_repeats_are_ignored() {
        let t0 = Instant::now();
        let mut pacer = Pacer::new(t0, 15);
        let mut seq = 0;
        step(&mut pacer, &mut seq, t0);
        assert!(pacer.request_keyframe(t0 + ms(10)));
        assert!(!pacer.request_keyframe(t0 + ms(400)));
        step(&mut pacer, &mut seq, t0 + ms(100));
        step(&mut pacer, &mut seq, t0 + ms(200));
        step(&mut pacer, &mut seq, t0 + ms(10_300));
        assert!(pacer.is_stalled());
        assert!(pacer.request_keyframe(t0 + ms(10_400)));
        assert_eq!(pacer.in_flight(), 0);
        assert_eq!(
            step(&mut pacer, &mut seq, t0 + ms(10_400)),
            TickDecision::Capture { keyframe: true }
        );
    }

    #[test]
    fn pacing_keyframe_flag_stays_until_a_keyframe_is_sent() {
        let t0 = Instant::now();
        let mut pacer = Pacer::new(t0, 15);
        assert_eq!(pacer.tick(t0), TickDecision::Capture { keyframe: true });
        // Nothing was sent (say the capture failed): still a keyframe next.
        assert_eq!(
            pacer.tick(t0 + ms(70)),
            TickDecision::Capture { keyframe: true }
        );
        pacer.sent(1, t0 + ms(70), true);
        pacer.force_keyframe();
        assert_eq!(
            pacer.tick(t0 + ms(140)),
            TickDecision::Capture { keyframe: true }
        );
    }

    #[test]
    fn pacing_frame_rate_sets_the_tick_interval() {
        let t0 = Instant::now();
        let mut pacer = Pacer::new(t0, 15);
        pacer.tick(t0);
        assert_eq!(pacer.next_tick(), t0 + Duration::from_secs(1) / 15);
        pacer.set_max_fps(5);
        pacer.tick(t0 + ms(100));
        assert_eq!(pacer.next_tick(), t0 + ms(300));
    }

    #[test]
    fn pacing_auto_climbs_on_a_good_link_with_a_keyframe_and_tells_the_viewer() {
        let t0 = Instant::now();
        let mut pacer = Pacer::new(t0, 10);
        // The browser's `settings` after `hello` asks Auto to say its level.
        pacer.set_quality(Quality::Auto, Level::High, t0);
        assert_eq!(pacer.take_auto_news(), Some(Level::High));
        assert_eq!(pacer.take_auto_news(), None);
        assert_eq!(pacer.jpeg_quality(), 90);
        let mut seq = 0;
        let mut now = t0;
        let mut keyframes = 0;
        // Every frame comes back in 40 ms.
        while now < t0 + ms(3_500) {
            if let TickDecision::Capture { keyframe } = step(&mut pacer, &mut seq, now) {
                keyframes += u32::from(keyframe);
            }
            pacer.ack(seq, now + ms(40));
            now += ms(100);
        }
        assert_eq!(pacer.jpeg_quality(), 95);
        assert_eq!(pacer.take_auto_news(), Some(Level::ExtraHigh));
        // The first frame, and the climb so a still screen sharpens too.
        assert_eq!(keyframes, 2);
    }

    #[test]
    fn pacing_auto_steps_down_when_frames_back_up() {
        let t0 = Instant::now();
        let mut pacer = Pacer::new(t0, 10);
        pacer.set_quality(Quality::High, Level::High, t0);
        assert!(pacer.set_quality(Quality::Auto, Level::ExtraHigh, t0));
        assert_eq!(pacer.jpeg_quality(), 95);
        let mut seq = 0;
        let mut now = t0;
        // A fast start, then the link stops acknowledging.
        while now < t0 + ms(1_000) {
            step(&mut pacer, &mut seq, now);
            pacer.ack(seq, now + ms(40));
            now += ms(100);
        }
        while now < t0 + ms(3_100) {
            step(&mut pacer, &mut seq, now);
            now += ms(100);
        }
        assert_eq!(pacer.jpeg_quality(), 90);
    }

    #[test]
    fn pacing_auto_starts_where_the_viewer_says_then_staying_auto_keeps_its_level() {
        let t0 = Instant::now();
        let mut pacer = Pacer::new(t0, 10);
        // The first `settings` is Auto, as the session already was: it
        // still starts where the viewer's last session got to.
        assert!(pacer.set_quality(Quality::Auto, Level::ExtraHigh, t0));
        assert_eq!(pacer.jpeg_quality(), 95);
        assert_eq!(pacer.take_auto_news(), Some(Level::ExtraHigh));
        // A later Auto (a new page, a scale change) keeps the level, and
        // tells the viewer again.
        assert!(!pacer.set_quality(Quality::Auto, Level::High, t0));
        assert_eq!(pacer.jpeg_quality(), 95);
        assert_eq!(pacer.take_auto_news(), Some(Level::ExtraHigh));
    }

    #[test]
    fn pacing_fixed_quality_ignores_pressure_and_change_wants_a_keyframe() {
        let t0 = Instant::now();
        let mut pacer = Pacer::new(t0, 10);
        pacer.sent(1, t0, true);
        assert!(pacer.set_quality(Quality::Low, Level::High, t0));
        assert!(!pacer.set_quality(Quality::Low, Level::High, t0));
        assert_eq!(pacer.jpeg_quality(), 40);
        assert_eq!(pacer.take_auto_news(), None);
        assert_eq!(pacer.tick(t0), TickDecision::Capture { keyframe: true });
        pacer.sent(2, t0, true);
        for i in 1..40 {
            pacer.tick(t0 + ms(i * 100));
        }
        assert_eq!(pacer.jpeg_quality(), 40);
    }
}
