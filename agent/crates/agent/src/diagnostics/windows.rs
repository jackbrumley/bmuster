//! Windows platform logs (SPEC-DIAGNOSTICS 4).
//!
//! - **Event Log:** after a failed session or check, one fixed query:
//!   System-log Service Control Manager events from the last 15 minutes that
//!   name BMuster, and Application-log errors from BMuster's processes
//!   (`wevtutil qe` with fixed XPath, at most 100 events, five seconds).
//!   Nothing from the server or browser shapes it.
//! - **Desktop helper log:** the helper runs in the console session and
//!   writes `desktop-helper.log`; the service follows that file and ships
//!   each new line with source `helper`. Lines the helper wrote as
//!   `[session-timeline] {…}` or `[session-stats] {…}` ship as those records.
//!
//! The parsing is plain code, tested on every platform; only running
//! `wevtutil` and following the file happen on Windows.

use crate::logging::ShipQueue;
use bmuster_protocol::checks::{STATS_TARGET, TIMELINE_TARGET};
use bmuster_protocol::logs::{LogLevel, LogSource};

/// The most events one query returns.
pub const MAX_EVENTS: usize = 100;
/// The window the query looks back over, in milliseconds.
const LOOK_BACK_MS: u64 = 15 * 60 * 1000;
/// The target of shipped Event Log lines.
#[cfg(windows)]
pub const EVENT_LOG_TARGET: &str = "event-log";
/// The target of the desktop helper's shipped lines.
pub const HELPER_TARGET: &str = "desktop-helper";
/// What a BMuster event names.
const NAMED: &str = "bmuster";

/// The two fixed queries: (log, XPath).
pub fn event_log_queries() -> [(&'static str, String); 2] {
    [
        (
            "System",
            format!(
                "*[System[Provider[@Name='Service Control Manager'] and TimeCreated[timediff(@SystemTime) <= {LOOK_BACK_MS}]]]"
            ),
        ),
        (
            "Application",
            format!(
                "*[System[(Level=1 or Level=2) and TimeCreated[timediff(@SystemTime) <= {LOOK_BACK_MS}]]]"
            ),
        ),
    ]
}

/// `wevtutil`'s arguments for one fixed query, newest first, `count` events.
pub fn event_log_arguments(log: &str, xpath: &str, count: usize) -> Vec<String> {
    vec![
        "qe".into(),
        log.into(),
        format!("/q:{xpath}"),
        format!("/c:{}", count.min(MAX_EVENTS)),
        "/rd:true".into(),
        "/f:text".into(),
    ]
}

/// `wevtutil /f:text` output as one line per event, keeping only events
/// that name BMuster (SCM events name the service; application errors name
/// the faulting program).
pub fn events_naming_bmuster(text: &str) -> Vec<String> {
    let mut events = Vec::new();
    let mut current: Vec<&str> = Vec::new();
    let mut flush = |current: &mut Vec<&str>| {
        let event = current.join(" | ");
        if event.to_ascii_lowercase().contains(NAMED) {
            events.push(event);
        }
        current.clear();
    };
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with("Event[") {
            flush(&mut current);
            continue;
        }
        if !line.is_empty() {
            current.push(line);
        }
    }
    flush(&mut current);
    events
}

/// One line of `desktop-helper.log` (`<HTTP date> <LEVEL> <text>`) as a
/// record: its level, source, target and text.
pub fn helper_record(line: &str) -> Option<(LogLevel, LogSource, String, String)> {
    let line = line.trim_end();
    if line.is_empty() {
        return None;
    }
    // "Mon, 09 Nov 2026 10:00:00 GMT " is 30 bytes.
    let rest = line
        .get(30..)
        .filter(|_| line.get(26..29) == Some("GMT"))
        .unwrap_or(line);
    let (level, text) = match rest.split_once(' ') {
        Some(("ERROR", text)) => (LogLevel::Error, text),
        Some(("WARN", text)) => (LogLevel::Warn, text),
        Some(("INFO", text)) => (LogLevel::Info, text),
        Some(("DEBUG", text)) => (LogLevel::Debug, text),
        Some(("TRACE", text)) => (LogLevel::Trace, text),
        _ => (LogLevel::Info, rest),
    };
    let text = text.trim_start();
    for target in [TIMELINE_TARGET, STATS_TARGET] {
        if let Some(json) = text.strip_prefix(&format!("[{target}] ")) {
            return Some((
                LogLevel::Info,
                LogSource::Agent,
                target.to_string(),
                json.to_string(),
            ));
        }
    }
    Some((
        level,
        LogSource::Helper,
        HELPER_TARGET.to_string(),
        text.to_string(),
    ))
}

/// Queues new lines of the helper's log.
pub fn ship_helper_lines(queue: &ShipQueue, text: &str) {
    for line in text.split('\n') {
        if let Some((level, source, target, text)) = helper_record(line) {
            queue.push(level, source, &target, &text);
        }
    }
}

#[cfg(windows)]
mod running {
    use super::*;
    use crate::logging::SHIP;
    use std::io::{Read as _, Seek as _, SeekFrom};
    use std::path::PathBuf;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    const DEADLINE: Duration = Duration::from_secs(5);

    /// Runs one fixed query with a deadline; its events naming BMuster.
    pub fn query(log: &str, xpath: &str, count: usize) -> Result<Vec<String>, String> {
        use std::os::windows::process::CommandExt as _;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut child = Command::new("wevtutil")
            .args(event_log_arguments(log, xpath, count))
            .creation_flags(CREATE_NO_WINDOW)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| format!("Could not run wevtutil: {error}"))?;
        let mut stdout = child.stdout.take().ok_or("wevtutil has no output")?;
        let reader = std::thread::spawn(move || {
            let mut bytes = Vec::new();
            let _ = (&mut stdout).take(512 * 1024).read_to_end(&mut bytes);
            bytes
        });
        let until = Instant::now() + DEADLINE;
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    let bytes = reader.join().unwrap_or_default();
                    if !status.success() {
                        return Err(format!("wevtutil exited with {status}"));
                    }
                    return Ok(events_naming_bmuster(&String::from_utf8_lossy(&bytes)));
                }
                Ok(None) if Instant::now() < until => std::thread::sleep(Duration::from_millis(50)),
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("The Event Log query timed out after five seconds".into());
                }
            }
        }
    }

    /// After a failed `kind` session or check: the fixed queries, shipped.
    pub fn ship_event_log(queue: &ShipQueue, kind: &str) {
        let push =
            |level, text: &str| queue.push(level, LogSource::Journal, EVENT_LOG_TARGET, text);
        let mut shipped = 0;
        for (log, xpath) in event_log_queries() {
            match query(log, &xpath, MAX_EVENTS) {
                Ok(events) => {
                    for event in events.into_iter().take(MAX_EVENTS - shipped) {
                        push(LogLevel::Info, &format!("{log}: {event}"));
                        shipped += 1;
                    }
                }
                Err(reason) => push(
                    LogLevel::Warn,
                    &format!("The {log} Event Log could not be read: {reason}"),
                ),
            }
        }
        push(
            LogLevel::Info,
            &format!("After the failed {kind}: {shipped} Event Log entries naming BMuster from the last 15 minutes."),
        );
    }

    /// Follows the helper's log from its current end, shipping new lines.
    pub fn follow_helper_log(path: PathBuf) {
        let started = std::thread::Builder::new()
            .name("helper log".into())
            .spawn(move || {
                let mut position = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                let mut partial = String::new();
                loop {
                    std::thread::sleep(Duration::from_secs(1));
                    let Ok(mut file) = std::fs::File::open(&path) else {
                        continue;
                    };
                    let length = file.metadata().map(|m| m.len()).unwrap_or(0);
                    if length < position {
                        // Rotated: start again at the top of the new file.
                        position = 0;
                        partial.clear();
                    }
                    if length == position || file.seek(SeekFrom::Start(position)).is_err() {
                        continue;
                    }
                    let mut bytes = Vec::new();
                    let read = (&mut file).take(256 * 1024).read_to_end(&mut bytes);
                    let Ok(read) = read else {
                        continue;
                    };
                    position += read as u64;
                    partial.push_str(&String::from_utf8_lossy(&bytes));
                    if let Some(end) = partial.rfind('\n') {
                        let complete: String = partial.drain(..=end).collect();
                        ship_helper_lines(&SHIP, &complete);
                    }
                }
            });
        if let Err(error) = started {
            log::warn!("Could not follow the desktop helper's log: {error}");
        }
    }
}

#[cfg(windows)]
pub use running::{follow_helper_log, query, ship_event_log};

#[cfg(test)]
mod tests {
    use super::*;

    /// SPEC-DIAGNOSTICS D8.
    #[test]
    fn event_log_query_is_fixed() {
        let [(system, scm), (application, errors)] = event_log_queries();
        assert_eq!(system, "System");
        assert_eq!(
            scm,
            "*[System[Provider[@Name='Service Control Manager'] and TimeCreated[timediff(@SystemTime) <= 900000]]]"
        );
        assert_eq!(application, "Application");
        assert_eq!(
            errors,
            "*[System[(Level=1 or Level=2) and TimeCreated[timediff(@SystemTime) <= 900000]]]"
        );
        assert_eq!(
            event_log_arguments(system, &scm, 1000),
            [
                "qe".to_string(),
                "System".into(),
                format!("/q:{scm}"),
                "/c:100".into(),
                "/rd:true".into(),
                "/f:text".into()
            ],
            "at most 100 events, newest first"
        );
        let text = "Event[0]:\r\n  Log Name: System\r\n  Source: Service Control Manager\r\n  Description: The BMuster Agent service terminated unexpectedly.\r\n\r\nEvent[1]:\r\n  Log Name: System\r\n  Description: The Print Spooler service entered the running state.\r\n";
        assert_eq!(
            events_naming_bmuster(text),
            ["Log Name: System | Source: Service Control Manager | Description: The BMuster Agent service terminated unexpectedly."]
        );
    }

    #[test]
    fn helper_log_lines_become_records() {
        assert_eq!(
            helper_record("Mon, 09 Nov 2026 10:00:00 GMT WARN  DXGI Desktop Duplication failed"),
            Some((
                LogLevel::Warn,
                LogSource::Helper,
                HELPER_TARGET.into(),
                "DXGI Desktop Duplication failed".into()
            ))
        );
        assert_eq!(
            helper_record(
                r#"Mon, 09 Nov 2026 10:00:00 GMT INFO  [session-timeline] {"sessionId":"s"}"#
            ),
            Some((
                LogLevel::Info,
                LogSource::Agent,
                TIMELINE_TARGET.into(),
                r#"{"sessionId":"s"}"#.into()
            ))
        );
        assert_eq!(helper_record("   "), None);
        let queue: &'static ShipQueue = Box::leak(Box::new(ShipQueue::new()));
        queue.enable();
        ship_helper_lines(
            queue,
            "Mon, 09 Nov 2026 10:00:00 GMT INFO  a\nMon, 09 Nov 2026 10:00:01 GMT ERROR b token=x\n",
        );
        let (records, _) = queue.take();
        assert_eq!(records.len(), 2);
        assert_eq!(records[1].level, LogLevel::Error);
        assert_eq!(records[1].text, "[redacted diagnostic line]");
    }
}
