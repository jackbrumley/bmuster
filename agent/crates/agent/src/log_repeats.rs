//! Collapses repeated log records before they ship (SPEC-AGENT-LOGS AL15).
//!
//! During an outage the agent logs the same few lines about once a minute
//! for as long as it lasts. The first of each (level, target, text) ships;
//! identical records in the next [`WINDOW_MS`] are counted instead, and one
//! summary ("Repeated 44 more times in the last 45 minutes: …") ships when
//! the window ends or when the same target logs something new, such as
//! "Live socket connected." after the failures. Records that alternate (a
//! failure, then "Reconnecting in 60 s") each collapse on their own.

use crate::logging::Pending;
use bmuster_protocol::logs::{cut_text, LogLevel, LogSource, MAX_RECORD_TEXT_BYTES};
use std::collections::BTreeMap;

/// How long one record's repeats are counted before a summary ships.
pub const WINDOW_MS: u64 = 30 * 60 * 1000;
/// Kinds of record remembered at once; past this every summary ships and
/// the memory starts again.
const MAX_REMEMBERED: usize = 512;

type Key = (LogLevel, String, String);

struct Seen {
    source: LogSource,
    /// When the shipped record that opened this window was logged.
    since: u64,
    /// Identical records held back since then.
    repeats: u64,
}

pub struct Repeats {
    seen: BTreeMap<Key, Seen>,
}

impl Repeats {
    pub const fn new() -> Self {
        Self {
            seen: BTreeMap::new(),
        }
    }

    /// What to queue for `record`: summaries that are due first, then the
    /// record itself unless it repeats one shipped in the last window.
    pub fn admit(&mut self, record: Pending) -> Vec<Pending> {
        let key = (record.level, record.target.clone(), record.text.clone());
        let mut out = Vec::new();
        if let Some(seen) = self.seen.get_mut(&key) {
            if record.at.saturating_sub(seen.since) < WINDOW_MS {
                seen.repeats += 1;
                return out;
            }
            if let Some(seen) = self.seen.remove(&key) {
                out.extend(summary(&key, &seen, record.at));
            }
        } else {
            // Something new from this target: what it repeated before has
            // stopped, so say how often now, before the new record.
            out.extend(self.close(record.at, |(_, target, _), seen| {
                *target == record.target && seen.repeats > 0
            }));
        }
        if self.seen.len() >= MAX_REMEMBERED {
            out.extend(self.close(record.at, |_, _| true));
        }
        self.seen.insert(
            key,
            Seen {
                source: record.source,
                since: record.at,
                repeats: 0,
            },
        );
        out.push(record);
        out
    }

    /// Summaries for windows that have ended by `now`, which are forgotten,
    /// so the next identical record ships again.
    pub fn sweep(&mut self, now: u64) -> Vec<Pending> {
        self.close(now, |_, seen| now.saturating_sub(seen.since) >= WINDOW_MS)
    }

    /// Forgets the records `done` picks, returning summaries (oldest window
    /// first) for those that were held back.
    fn close(&mut self, now: u64, done: impl Fn(&Key, &Seen) -> bool) -> Vec<Pending> {
        let keys: Vec<Key> = self
            .seen
            .iter()
            .filter(|(key, seen)| done(key, seen))
            .map(|(key, _)| key.clone())
            .collect();
        let mut closed: Vec<(Key, Seen)> = keys
            .into_iter()
            .filter_map(|key| self.seen.remove(&key).map(|seen| (key, seen)))
            .collect();
        closed.sort_by_key(|(_, seen)| seen.since);
        closed
            .iter()
            .filter_map(|(key, seen)| summary(key, seen, now))
            .collect()
    }
}

/// "Repeated N more times in the last M minutes: <text>", or nothing when
/// no record was held back.
fn summary(key: &Key, seen: &Seen, now: u64) -> Option<Pending> {
    if seen.repeats == 0 {
        return None;
    }
    let (level, target, text) = key;
    let minutes = now.saturating_sub(seen.since).div_ceil(60_000).max(1);
    let times = if seen.repeats == 1 { "time" } else { "times" };
    let span = if minutes == 1 {
        "minute".to_string()
    } else {
        format!("{minutes} minutes")
    };
    Some(Pending {
        at: now,
        level: *level,
        source: seen.source,
        target: target.clone(),
        text: cut_text(
            &format!(
                "Repeated {} more {times} in the last {span}: {text}",
                seen.repeats
            ),
            MAX_RECORD_TEXT_BYTES,
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINUTE: u64 = 60_000;

    fn record(at: u64, level: LogLevel, target: &str, text: &str) -> Pending {
        Pending {
            at,
            level,
            source: LogSource::Agent,
            target: target.into(),
            text: text.into(),
        }
    }

    fn texts(records: &[Pending]) -> Vec<&str> {
        records.iter().map(|r| r.text.as_str()).collect()
    }

    const SOCKET: &str = "bmuster_agent::socket";
    const FAILED: &str = "Live socket: HTTP 502 Bad Gateway from the server or its proxy";
    const AGAIN: &str = "Reconnecting the live socket in 60 s.";

    #[test]
    fn repeated_records_collapse_into_summaries() {
        let mut repeats = Repeats::new();
        let mut shipped = Vec::new();
        // A 45-minute outage: a failure and a reconnect line every minute.
        for minute in 0..45 {
            let at = minute * MINUTE;
            shipped.extend(repeats.admit(record(at, LogLevel::Warn, SOCKET, FAILED)));
            shipped.extend(repeats.admit(record(at + 1, LogLevel::Info, SOCKET, AGAIN)));
            shipped.extend(repeats.sweep(at + 2));
        }
        shipped.extend(repeats.admit(record(
            45 * MINUTE,
            LogLevel::Info,
            SOCKET,
            "Live socket connected.",
        )));
        assert_eq!(
            texts(&shipped),
            vec![
                FAILED,
                AGAIN,
                // After 30 minutes the next repeat closes the window with one
                // summary, then ships in full and opens a new window.
                &format!("Repeated 29 more times in the last 30 minutes: {FAILED}"),
                FAILED,
                &format!("Repeated 29 more times in the last 30 minutes: {AGAIN}"),
                AGAIN,
                // A new line from the same target closes the windows early.
                &format!("Repeated 14 more times in the last 15 minutes: {FAILED}"),
                &format!("Repeated 14 more times in the last 15 minutes: {AGAIN}"),
                "Live socket connected.",
            ]
        );
        let summary = &shipped[2];
        assert_eq!(summary.level, LogLevel::Warn);
        assert_eq!(summary.target, SOCKET);
        assert_eq!(summary.at, 30 * MINUTE);
        assert_eq!(shipped[4].level, LogLevel::Info);
    }

    #[test]
    fn a_record_that_stops_is_summarised_when_its_window_ends() {
        let mut repeats = Repeats::new();
        repeats.admit(record(0, LogLevel::Warn, SOCKET, FAILED));
        for minute in 1..5 {
            assert!(repeats
                .admit(record(minute * MINUTE, LogLevel::Warn, SOCKET, FAILED))
                .is_empty());
        }
        assert!(repeats.sweep(WINDOW_MS - 1).is_empty());
        let due = repeats.sweep(WINDOW_MS);
        assert_eq!(
            texts(&due),
            vec![&format!(
                "Repeated 4 more times in the last 30 minutes: {FAILED}"
            )]
        );
    }

    #[test]
    fn level_target_and_text_must_all_match() {
        let mut repeats = Repeats::new();
        let mut shipped = Vec::new();
        shipped.extend(repeats.admit(record(0, LogLevel::Warn, SOCKET, "same")));
        shipped.extend(repeats.admit(record(1, LogLevel::Error, SOCKET, "same")));
        shipped.extend(repeats.admit(record(2, LogLevel::Warn, "bmuster_agent::worker", "same")));
        shipped.extend(repeats.admit(record(3, LogLevel::Warn, SOCKET, "same")));
        assert_eq!(shipped.len(), 3, "only the exact repeat is held back");
        // A record that never repeats leaves without a summary.
        assert_eq!(repeats.sweep(WINDOW_MS + 10).len(), 1);
        assert!(repeats.sweep(2 * WINDOW_MS).is_empty());
        assert_eq!(
            repeats
                .admit(record(2 * WINDOW_MS, LogLevel::Warn, SOCKET, "same"))
                .len(),
            1,
            "after its window a record ships again"
        );
    }

    #[test]
    fn a_short_burst_says_once_in_a_minute() {
        let mut repeats = Repeats::new();
        repeats.admit(record(0, LogLevel::Warn, SOCKET, FAILED));
        repeats.admit(record(10, LogLevel::Warn, SOCKET, FAILED));
        let shipped = repeats.admit(record(20, LogLevel::Info, SOCKET, "Live socket connected."));
        assert_eq!(
            texts(&shipped),
            vec![
                &format!("Repeated 1 more time in the last minute: {FAILED}"),
                "Live socket connected."
            ]
        );
    }

    #[test]
    fn memory_is_bounded() {
        let mut repeats = Repeats::new();
        for n in 0..(MAX_REMEMBERED as u64 * 3) {
            repeats.admit(record(n, LogLevel::Info, SOCKET, &format!("line {n}")));
        }
        assert!(repeats.seen.len() <= MAX_REMEMBERED);
    }
}
