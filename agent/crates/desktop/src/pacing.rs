//! Pacing: the ack window, the frame rate, keyframe requests, the stall
//! guard and auto quality (SPEC-DESKTOP 4.3, R5).
//!
//! A pure state machine: every method takes the current time, so the tests
//! drive it with a made-up clock. The session asks [`Pacer::tick`] on each
//! capture tick and only captures and encodes when it says so. Frames are
//! dropped before encoding, never after: a skipped tick costs nothing,
//! because the capturer keeps adding up the damage for the next frame.

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
/// Auto quality drops a step after the window blocked capture this long.
pub const LOWER_AFTER: Duration = Duration::from_secs(2);
/// Auto quality rises a step after this long without the window filling.
pub const RAISE_AFTER: Duration = Duration::from_secs(10);

/// JPEG quality for each Auto step, lowest first.
pub const AUTO_STEPS: [u8; 5] = [30, 45, 60, 75, 85];
/// The step Auto starts at.
pub const AUTO_START: usize = 2;

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
    fn fixed_jpeg(self) -> Option<u8> {
        match self {
            Quality::Auto => None,
            Quality::Low => Some(40),
            Quality::Medium => Some(65),
            Quality::High => Some(90),
            Quality::ExtraHigh => Some(95),
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
    auto_step: usize,
    /// When the window started blocking captures (continuously).
    blocked_since: Option<Instant>,
    /// Last time the window was full, or Auto last changed step.
    last_pressure: Instant,
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
            auto_step: AUTO_START,
            blocked_since: None,
            last_pressure: now,
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
        self.quality
            .fixed_jpeg()
            .unwrap_or(AUTO_STEPS[self.auto_step])
    }

    /// Applies the `quality` setting. Returns true when it changed, which
    /// calls for a keyframe so every tile shows the new quality.
    pub fn set_quality(&mut self, quality: Quality, now: Instant) -> bool {
        if quality == self.quality {
            return false;
        }
        self.quality = quality;
        self.auto_step = AUTO_START;
        self.blocked_since = None;
        self.last_pressure = now;
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
        self.blocked_since = None;
        self.next_capture = self.next_capture.min(now);
    }

    /// Decides one capture tick. Call it when [`Pacer::next_tick`] is due.
    pub fn tick(&mut self, now: Instant) -> TickDecision {
        self.next_capture = now + self.frame_interval;

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
            self.last_pressure = now;
            let since = *self.blocked_since.get_or_insert(now);
            if self.quality == Quality::Auto
                && now.saturating_duration_since(since) >= LOWER_AFTER
                && self.auto_step > 0
            {
                self.auto_step -= 1;
                self.blocked_since = Some(now);
            }
            return TickDecision::WindowFull;
        }

        self.blocked_since = None;
        self.missed_tick = false;
        if self.quality == Quality::Auto
            && now.saturating_duration_since(self.last_pressure) >= RAISE_AFTER
        {
            if self.auto_step + 1 < AUTO_STEPS.len() {
                self.auto_step += 1;
            }
            self.last_pressure = now;
        }
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
    fn pacing_auto_quality_lowers_after_two_seconds_blocked_and_raises_after_ten_clear() {
        let t0 = Instant::now();
        let mut pacer = Pacer::new(t0, 10);
        let start = pacer.jpeg_quality();
        let mut seq = 0;
        step(&mut pacer, &mut seq, t0);
        step(&mut pacer, &mut seq, t0 + ms(100));
        // Blocked from 200 ms; one step down at 2200 ms, another at 4200 ms.
        let mut now = t0 + ms(200);
        while now < t0 + ms(2_200) {
            assert_eq!(step(&mut pacer, &mut seq, now), TickDecision::WindowFull);
            now += ms(100);
        }
        assert_eq!(pacer.jpeg_quality(), start);
        step(&mut pacer, &mut seq, t0 + ms(2_200));
        assert_eq!(pacer.jpeg_quality(), AUTO_STEPS[AUTO_START - 1]);

        // Acks keep up from here: 10 s without pressure raises it again.
        pacer.ack(seq, t0 + ms(2_300));
        let mut now = t0 + ms(2_300);
        while now < t0 + ms(12_200) {
            step(&mut pacer, &mut seq, now);
            pacer.ack(seq, now);
            now += ms(100);
        }
        assert_eq!(pacer.jpeg_quality(), AUTO_STEPS[AUTO_START - 1]);
        step(&mut pacer, &mut seq, t0 + ms(12_300));
        assert_eq!(pacer.jpeg_quality(), start);
    }

    #[test]
    fn pacing_fixed_quality_ignores_pressure_and_change_wants_a_keyframe() {
        let t0 = Instant::now();
        let mut pacer = Pacer::new(t0, 10);
        pacer.sent(1, t0, true);
        assert!(pacer.set_quality(Quality::Low, t0));
        assert!(!pacer.set_quality(Quality::Low, t0));
        assert_eq!(pacer.jpeg_quality(), 40);
        assert_eq!(pacer.tick(t0), TickDecision::Capture { keyframe: true });
        pacer.sent(2, t0, true);
        for i in 1..40 {
            pacer.tick(t0 + ms(i * 100));
        }
        assert_eq!(pacer.jpeg_quality(), 40);
    }
}
