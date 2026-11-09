//! Diagnostics the agent ships without being asked (SPEC-AGENT-LOGS 1):
//! the stderr of the helpers it starts, and, when a terminal, files or
//! desktop session fails to start, one fixed journal query for its own units.
//!
//! Never collect terminal output, exec commands, shell history, file contents
//! or arbitrary paths or commands. Every line is redacted before it is queued.

use crate::logging::{helper_line, ShipQueue, SHIP};
use bmuster_protocol::logs::{LogLevel, LogSource};
#[cfg(target_os = "linux")]
use std::ffi::OsString;
use std::io::{BufRead as _, BufReader, Read};
#[cfg(target_os = "linux")]
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[cfg(target_os = "linux")]
const MAX_JOURNAL_BYTES: usize = 192 * 1024;
#[cfg(target_os = "linux")]
const MAX_JOURNAL_LINES: usize = 250;
#[cfg(target_os = "linux")]
const JOURNAL_TIMEOUT: Duration = Duration::from_secs(5);
/// At most one journal query a minute, however many sessions fail.
const JOURNAL_EVERY: Duration = Duration::from_secs(60);
/// The target of shipped journal lines.
const JOURNAL_TARGET: &str = "journal";

#[cfg(target_os = "linux")]
fn journal_arguments() -> Vec<OsString> {
    [
        "--no-pager".to_string(),
        "--output=short-iso".to_string(),
        "--since=15 minutes ago".to_string(),
        format!("--lines={MAX_JOURNAL_LINES}"),
        "--unit=bmuster-agent.service".to_string(),
        "--unit=bmuster-terminal-*.service".to_string(),
        "--unit=bmuster-files-*.service".to_string(),
    ]
    .into_iter()
    .map(OsString::from)
    .collect()
}

/// What the fixed journal query found.
#[derive(Debug, PartialEq, Eq)]
pub enum Journal {
    Available {
        lines: Vec<String>,
        truncated: bool,
    },
    Unavailable {
        reason: String,
    },
    #[cfg(not(target_os = "linux"))]
    Unsupported,
}

/// Version 1's redaction: a line naming authentication material is replaced whole.
pub fn redact(line: &str) -> String {
    let lower = line.to_ascii_lowercase();
    if [
        "authorization",
        "password=",
        "secret=",
        "token=",
        "pin=",
        "join-code=",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
    {
        "[redacted diagnostic line]".to_string()
    } else {
        line.to_string()
    }
}

#[cfg(target_os = "linux")]
fn cap_lines(lines: Vec<String>, max: usize) -> (Vec<String>, bool) {
    let truncated = lines.len() > max;
    let start = lines.len().saturating_sub(max);
    (lines.into_iter().skip(start).collect(), truncated)
}

/// A session of `kind` (terminal, files, desktop) failed to start: ship the
/// fixed journal query, on its own thread, at most once a minute.
pub fn session_failed(kind: &'static str) {
    static LAST: Mutex<Option<Instant>> = Mutex::new(None);
    {
        let mut last = LAST.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        if last.is_some_and(|at| at.elapsed() < JOURNAL_EVERY) {
            return;
        }
        *last = Some(Instant::now());
    }
    let started = std::thread::Builder::new()
        .name("journal diagnostics".into())
        .spawn(move || ship_journal(&SHIP, kind, journal()));
    if let Err(error) = started {
        log::warn!("Could not start the journal query: {error}");
    }
}

/// Queues the journal query's result after a failed `kind` session.
fn ship_journal(queue: &ShipQueue, kind: &str, journal: Journal) {
    let push = |level, text: &str| queue.push(level, LogSource::Journal, JOURNAL_TARGET, text);
    match journal {
        Journal::Available { lines, truncated } => {
            push(
                LogLevel::Info,
                &format!(
                    "A {kind} session failed to start; the agent's journal for the last 15 minutes{}:",
                    if truncated { " (newest lines only)" } else { "" }
                ),
            );
            for line in lines {
                push(LogLevel::Info, &line);
            }
        }
        Journal::Unavailable { reason } => push(
            LogLevel::Warn,
            &format!("A {kind} session failed to start; the journal could not be read: {reason}"),
        ),
        #[cfg(not(target_os = "linux"))]
        Journal::Unsupported => {}
    }
}

/// Reads a helper's stderr line by line on its own thread, shipping each
/// line with the helper's name.
pub fn ship_helper_stderr(helper: &'static str, stderr: Option<impl Read + Send + 'static>) {
    let Some(stderr) = stderr else {
        return;
    };
    let started = std::thread::Builder::new()
        .name(format!("{helper} stderr"))
        .spawn(move || ship_helper_lines(&SHIP, helper, stderr));
    if let Err(error) = started {
        log::warn!("Could not read the {helper}'s messages: {error}");
    }
}

fn ship_helper_lines(queue: &ShipQueue, helper: &str, stderr: impl Read) {
    for line in BufReader::new(stderr).split(b'\n') {
        let Ok(line) = line else {
            return;
        };
        let text = String::from_utf8_lossy(&line);
        let text = text.trim_end();
        if !text.is_empty() {
            helper_line(queue, helper, text);
        }
    }
}

fn journal() -> Journal {
    #[cfg(not(target_os = "linux"))]
    {
        Journal::Unsupported
    }
    #[cfg(target_os = "linux")]
    {
        linux_journal()
    }
}

#[cfg(target_os = "linux")]
fn linux_journal() -> Journal {
    let mut child = match Command::new("/usr/bin/timeout")
        .args(["--kill-after=1s", "5s", "/usr/bin/journalctl"])
        .args(journal_arguments())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            return Journal::Unavailable {
                reason: format!("Could not start the fixed journal query: {error}"),
            }
        }
    };
    let Some(mut stdout) = child.stdout.take() else {
        return Journal::Unavailable {
            reason: "The fixed journal query did not provide output".into(),
        };
    };
    let reader = match std::thread::Builder::new()
        .name("journal diagnostics reader".into())
        .spawn(move || {
            let mut bytes = Vec::new();
            let _ = (&mut stdout)
                .take((MAX_JOURNAL_BYTES + 1) as u64)
                .read_to_end(&mut bytes);
            let truncated = bytes.len() > MAX_JOURNAL_BYTES;
            bytes.truncate(MAX_JOURNAL_BYTES);
            if truncated {
                let _ = std::io::copy(&mut stdout, &mut std::io::sink());
            }
            (bytes, truncated)
        }) {
        Ok(reader) => reader,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Journal::Unavailable {
                reason: format!("Could not start the journal reader: {error}"),
            };
        }
    };
    let deadline = Instant::now() + JOURNAL_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let Ok((stdout, truncated)) = reader.join() else {
                    return Journal::Unavailable {
                        reason: "The journal reader stopped unexpectedly".into(),
                    };
                };
                if !status.success() {
                    return Journal::Unavailable {
                        reason: format!("The fixed journal query exited with {status}"),
                    };
                }
                let text = String::from_utf8_lossy(&stdout);
                let lines: Vec<String> = text.lines().map(str::to_string).collect();
                let (lines, line_truncated) = cap_lines(lines, MAX_JOURNAL_LINES);
                return Journal::Available {
                    lines,
                    truncated: truncated || line_truncated,
                };
            }
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(50));
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Journal::Unavailable {
                    reason: "The fixed journal query timed out after five seconds".into(),
                };
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Journal::Unavailable {
                    reason: format!("Could not check the journal query: {error}"),
                };
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_authentication_material_is_redacted() {
        assert_eq!(
            redact("Bearer authorization: abc"),
            "[redacted diagnostic line]"
        );
        assert_eq!(redact("join-code=482913"), "[redacted diagnostic line]");
        assert_eq!(
            redact("Could not start transient shell (exit 208)"),
            "Could not start transient shell (exit 208)"
        );
    }

    #[test]
    fn session_failure_ships_journal() {
        let queue: &'static ShipQueue = Box::leak(Box::new(ShipQueue::new()));
        queue.enable();
        ship_journal(
            queue,
            "terminal",
            Journal::Available {
                lines: vec![
                    "bmuster-terminal-1.service: Failed with result 'exit-code' (208)".into(),
                    "password=hunter2".into(),
                ],
                truncated: false,
            },
        );
        ship_journal(
            queue,
            "files",
            Journal::Unavailable {
                reason: "The fixed journal query timed out after five seconds".into(),
            },
        );
        let (records, _) = queue.take();
        let shown: Vec<(LogSource, &str, &str)> = records
            .iter()
            .map(|r| (r.source, r.target.as_str(), r.text.as_str()))
            .collect();
        assert_eq!(shown.len(), 4, "{shown:?}");
        assert!(shown[0].2.starts_with("A terminal session failed to start"));
        assert_eq!(
            shown[1],
            (
                LogSource::Journal,
                "journal",
                "bmuster-terminal-1.service: Failed with result 'exit-code' (208)"
            )
        );
        assert_eq!(shown[2].2, "[redacted diagnostic line]");
        assert!(shown[3].2.contains("timed out"));
        assert_eq!(records[3].level, LogLevel::Warn);

        ship_helper_lines(
            queue,
            "wayland-helper",
            &b"pipewiresrc: stream error\n\ntoken=abc\nlast line without newline"[..],
        );
        let (records, _) = queue.take();
        let shown: Vec<(LogSource, &str, &str)> = records
            .iter()
            .map(|r| (r.source, r.target.as_str(), r.text.as_str()))
            .collect();
        assert_eq!(
            shown,
            [
                (
                    LogSource::Helper,
                    "wayland-helper",
                    "pipewiresrc: stream error"
                ),
                (
                    LogSource::Helper,
                    "wayland-helper",
                    "[redacted diagnostic line]"
                ),
                (
                    LogSource::Helper,
                    "wayland-helper",
                    "last line without newline"
                ),
            ]
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn line_cap_keeps_the_newest_lines_and_reports_truncation() {
        assert_eq!(
            cap_lines(vec!["a".into(), "b".into(), "c".into()], 2),
            (vec!["b".into(), "c".into()], true)
        );
        assert_eq!(cap_lines(vec!["a".into()], 2), (vec!["a".into()], false));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn journal_query_is_fixed_and_excludes_arbitrary_commands() {
        let arguments: Vec<String> = journal_arguments()
            .into_iter()
            .map(|argument| argument.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            arguments,
            [
                "--no-pager",
                "--output=short-iso",
                "--since=15 minutes ago",
                "--lines=250",
                "--unit=bmuster-agent.service",
                "--unit=bmuster-terminal-*.service",
                "--unit=bmuster-files-*.service",
            ]
        );
    }
}
