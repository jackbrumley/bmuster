//! Self-checks and session timelines (SPEC-DIAGNOSTICS).
//!
//! - The agent runs a fixed list of checks, each trying one capability for
//!   real in a harmless way, and sends the latest results in its check-in
//!   (`checks`) and, after `run-checks`, on the live socket (`checks`).
//! - Each session's steps travel as one ordinary log record with the target
//!   [`TIMELINE_TARGET`] whose text is a [`SessionTimeline`] as JSON; desktop
//!   sessions add a [`SessionStats`] record every [`STATS_EVERY_MS`] with the
//!   target [`STATS_TARGET`].

use serde::{Deserialize, Serialize};

/// A check's detail is cut to this many bytes.
pub const MAX_CHECK_DETAIL_BYTES: usize = 2048;
/// At most this many results in one report.
pub const MAX_CHECKS: usize = 32;
/// The log record target of a session's timeline.
pub const TIMELINE_TARGET: &str = "session-timeline";
/// The log record target of a desktop session's figures.
pub const STATS_TARGET: &str = "session-stats";
/// How often a desktop session ships its figures.
pub const STATS_EVERY_MS: u64 = 30_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CheckStatus {
    Pass,
    Fail,
    /// The capability does not apply here (an X11 check on Wayland, …).
    NotApplicable,
}

/// One check's result.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    /// `systemd-run`, `terminal-pty`, …
    pub id: String,
    pub title: String,
    pub status: CheckStatus,
    /// The reason for a failure, or what passed; at most [`MAX_CHECK_DETAIL_BYTES`].
    pub detail: String,
    pub duration_ms: u64,
    /// Unix milliseconds.
    pub checked_at: u64,
}

/// The check-in's `checks`. Agents before 0.4.3 leave it out, which the
/// server reads as `unreported`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ChecksReport {
    /// The first run has not finished yet (it starts a minute after start).
    #[default]
    Pending,
    Results {
        results: Vec<CheckResult>,
    },
}

/// One step of a session, `t` milliseconds after it started.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimelineStep {
    pub t: u64,
    /// `ticket-checked`, `unit-started`, `first-byte`, `backend`, …
    pub step: String,
    pub detail: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TimelineOutcome {
    Ended,
    Failed,
}

/// What a session did, shipped when it ends (or at once when it fails).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTimeline {
    pub session_id: String,
    /// `terminal`, `exec`, `files` or `desktop`.
    pub kind: String,
    /// Unix milliseconds.
    pub started_at: u64,
    pub outcome: TimelineOutcome,
    pub reason: String,
    pub steps: Vec<TimelineStep>,
    /// Steps left out of the middle to keep the record small.
    pub omitted: u64,
}

/// A desktop session's figures over the last interval.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStats {
    pub session_id: String,
    pub interval_ms: u64,
    pub frames_sent: u64,
    pub capture_ms_avg: f64,
    pub encode_ms_avg: f64,
    pub bytes_per_second: u64,
    pub dropped_frames: u64,
    pub tiles: u64,
    /// `x11`, `kms`, `portal`, `dxgi`, `gdi` or `none`.
    pub backend: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn check_shapes_match_the_spec() {
        let result = CheckResult {
            id: "terminal-pty".into(),
            title: "Terminal on a pty".into(),
            status: CheckStatus::NotApplicable,
            detail: "No systemd".into(),
            duration_ms: 12,
            checked_at: 1_000,
        };
        assert_eq!(
            serde_json::to_value(&result).unwrap(),
            json!({
                "id": "terminal-pty",
                "title": "Terminal on a pty",
                "status": "not-applicable",
                "detail": "No systemd",
                "durationMs": 12,
                "checkedAt": 1000
            })
        );
        assert_eq!(
            serde_json::to_value(ChecksReport::Pending).unwrap(),
            json!({ "kind": "pending" })
        );
        assert_eq!(
            serde_json::to_value(ChecksReport::Results {
                results: vec![result]
            })
            .unwrap()["results"][0]["status"],
            "not-applicable"
        );
        let timeline = SessionTimeline {
            session_id: "s-1".into(),
            kind: "terminal".into(),
            started_at: 5,
            outcome: TimelineOutcome::Failed,
            reason: "exit 208".into(),
            steps: vec![TimelineStep {
                t: 3,
                step: "unit-started".into(),
                detail: "bmuster-terminal-s1.service".into(),
            }],
            omitted: 0,
        };
        assert_eq!(
            serde_json::to_value(&timeline).unwrap(),
            json!({
                "sessionId": "s-1",
                "kind": "terminal",
                "startedAt": 5,
                "outcome": "failed",
                "reason": "exit 208",
                "steps": [{ "t": 3, "step": "unit-started", "detail": "bmuster-terminal-s1.service" }],
                "omitted": 0
            })
        );
    }
}
