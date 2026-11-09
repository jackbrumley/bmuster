//! Session timelines (SPEC-DIAGNOSTICS 3): each session records its steps
//! with times (ticket checked, unit or helper started, first byte or frame,
//! backend, screens, ended and why) and ships them as one `info` record with
//! the target `session-timeline` when it ends; a failure ships at once.
//!
//! A session's threads enter its timeline ([`enter`]), so code deep in the
//! session (the screen watch, the helpers) can add a step with [`step`]
//! without being handed the timeline. Steps outside any session do nothing.
//!
//! Details are redacted like every other record and never carry terminal
//! output, command text or file contents: only what the agent itself says.

use crate::logging::{now_ms, ShipQueue, SHIP};
use bmuster_protocol::checks::{
    SessionStats, SessionTimeline, TimelineOutcome, TimelineStep, STATS_TARGET, TIMELINE_TARGET,
};
use bmuster_protocol::logs::{LogLevel, LogSource, MAX_RECORD_TEXT_BYTES};
use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

/// The most steps one timeline keeps: the first and last half of them.
pub const MAX_STEPS: usize = 40;
/// A step's detail is cut to this many bytes.
const MAX_DETAIL_BYTES: usize = 240;

pub struct Timeline {
    session_id: String,
    kind: &'static str,
    started: Instant,
    started_at: u64,
    steps: Mutex<Vec<TimelineStep>>,
    omitted: Mutex<u64>,
    shipped: AtomicBool,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn cut(text: &str, max: usize) -> String {
    let text = crate::diagnostics::redact(text);
    if text.len() <= max {
        return text;
    }
    let mut end = max.saturating_sub(3);
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}...", &text[..end])
}

impl Timeline {
    /// A timeline for session `session_id` of `kind` (`terminal`, `exec`,
    /// `files`, `desktop`), starting now.
    pub fn new(session_id: &str, kind: &'static str) -> Arc<Self> {
        Arc::new(Self {
            session_id: session_id.to_string(),
            kind,
            started: Instant::now(),
            started_at: now_ms(),
            steps: Mutex::new(Vec::new()),
            omitted: Mutex::new(0),
            shipped: AtomicBool::new(false),
        })
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    /// Adds a step now. Past [`MAX_STEPS`], the steps after the first half
    /// make way for the newest, and are counted as omitted.
    pub fn step(&self, step: &str, detail: &str) {
        let t = u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX);
        let mut steps = lock(&self.steps);
        if steps.len() >= MAX_STEPS {
            steps.remove(MAX_STEPS / 2);
            *lock(&self.omitted) += 1;
        }
        steps.push(TimelineStep {
            t,
            step: step.to_string(),
            detail: cut(detail, MAX_DETAIL_BYTES),
        });
    }

    /// The whole timeline, ended with `outcome` and `reason`.
    pub fn finish(&self, outcome: TimelineOutcome, reason: &str) -> SessionTimeline {
        SessionTimeline {
            session_id: self.session_id.clone(),
            kind: self.kind.to_string(),
            started_at: self.started_at,
            outcome,
            reason: cut(reason, MAX_DETAIL_BYTES),
            steps: lock(&self.steps).clone(),
            omitted: *lock(&self.omitted),
        }
    }

    /// Ships the timeline once: later calls do nothing, so a failure that
    /// shipped at once is not shipped again when the session thread ends.
    pub fn ship(&self, queue: &ShipQueue, outcome: TimelineOutcome, reason: &str) {
        if self.shipped.swap(true, Ordering::SeqCst) {
            return;
        }
        let step = match outcome {
            TimelineOutcome::Ended => "ended",
            TimelineOutcome::Failed => "failed",
        };
        self.step(step, reason);
        ship_json(queue, TIMELINE_TARGET, &fit(self.finish(outcome, reason)));
    }
}

/// The timeline as JSON within a record's text limit: steps are dropped
/// from the middle until it fits.
fn fit(mut timeline: SessionTimeline) -> String {
    loop {
        let text = serde_json::to_string(&timeline).unwrap_or_default();
        if text.len() <= MAX_RECORD_TEXT_BYTES || timeline.steps.len() <= 2 {
            return text;
        }
        timeline.steps.remove(timeline.steps.len() / 2);
        timeline.omitted += 1;
    }
}

/// One structured record. The worker ships it; a process that does not ship
/// (the Windows desktop helper) writes it to its log as `[target] json`,
/// which the service's tail of that log turns back into a record.
pub fn ship_json(queue: &ShipQueue, target: &str, json: &str) {
    if queue.is_enabled() {
        queue.push(LogLevel::Info, LogSource::Agent, target, json);
    } else {
        log::info!("[{target}] {json}");
    }
}

/// A desktop session's figures over the last interval.
pub fn ship_stats(queue: &ShipQueue, stats: &SessionStats) {
    ship_json(
        queue,
        STATS_TARGET,
        &serde_json::to_string(stats).unwrap_or_default(),
    );
}

thread_local! {
    static CURRENT: RefCell<Option<Arc<Timeline>>> = const { RefCell::new(None) };
}

/// While the guard lives, this thread's steps go to `timeline`.
pub struct Entered {
    previous: Option<Arc<Timeline>>,
}

pub fn enter(timeline: &Arc<Timeline>) -> Entered {
    let previous = CURRENT.with(|current| current.replace(Some(Arc::clone(timeline))));
    Entered { previous }
}

impl Drop for Entered {
    fn drop(&mut self) {
        let previous = self.previous.take();
        CURRENT.with(|current| *current.borrow_mut() = previous);
    }
}

/// The timeline this thread is in, if any.
pub fn current() -> Option<Arc<Timeline>> {
    CURRENT.with(|current| current.borrow().clone())
}

/// A step in this thread's session, if it is in one.
pub fn step(step: &str, detail: &str) {
    if let Some(timeline) = current() {
        timeline.step(step, detail);
    }
}

/// This thread's session failed: its timeline ships now.
pub fn failed(reason: &str) {
    if let Some(timeline) = current() {
        timeline.ship(&SHIP, TimelineOutcome::Failed, reason);
    }
}
