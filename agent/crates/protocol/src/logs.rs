//! Agent log shipping on the live socket (SPEC-AGENT-LOGS 1): the agent sends
//! `log-batch`, the server answers `log-ack` once it has stored the batch, and
//! the server can make the agent verbose for a while with `log-level`.

use serde::{Deserialize, Serialize};

/// At most this many records in one `log-batch`.
pub const MAX_BATCH_RECORDS: usize = 500;
/// At most this many bytes of JSON records in one `log-batch`.
pub const MAX_BATCH_BYTES: usize = 128 * 1024;
/// A record's text is cut to this many bytes, marker included.
pub const MAX_RECORD_TEXT_BYTES: usize = 4096;
/// A record's target (module path or helper name) is cut to this many bytes.
pub const MAX_RECORD_TARGET_BYTES: usize = 256;
/// The longest verbose window the server may ask for: four hours.
pub const MAX_VERBOSE_MS: u64 = 4 * 60 * 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LogLevel {
    Error,
    Warn,
    Info,
    Debug,
    Trace,
}

/// Where a record came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LogSource {
    /// The agent's own code.
    Agent,
    /// A line of a child helper's stderr; the target is the helper's name.
    Helper,
    /// The fixed journal query after a session failed to start.
    Journal,
}

/// One record in a batch. `seq` counts from 1 within its agent process (`instance`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogRecord {
    pub seq: u64,
    /// Unix milliseconds.
    pub at: u64,
    pub level: LogLevel,
    pub source: LogSource,
    pub target: String,
    pub text: String,
}

/// What `log-level` asks for: the agent's own debug records until `untilMs`,
/// or back to `info` now.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "level", rename_all = "kebab-case")]
pub enum VerboseLevel {
    Debug {
        #[serde(rename = "untilMs")]
        until_ms: u64,
    },
    Info,
}

/// `text` cut to at most `max` bytes on a character boundary, with a marker
/// saying how much was cut.
pub fn cut_text(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let marker = format!(" [cut {} bytes]", text.len());
    let mut end = max.saturating_sub(marker.len());
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{marker}", &text[..end])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn long_text_is_cut_with_a_marker() {
        let long = "é".repeat(5000);
        let cut = cut_text(&long, MAX_RECORD_TEXT_BYTES);
        assert!(cut.len() <= MAX_RECORD_TEXT_BYTES);
        assert!(cut.ends_with(" [cut 10000 bytes]"));
        assert_eq!(cut_text("short", 10), "short");
    }
}
