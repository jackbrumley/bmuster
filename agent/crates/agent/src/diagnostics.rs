//! Bounded, on-demand diagnostics for the authenticated Manage page.
//! Never collect shell output, history, or arbitrary paths/commands.

use bmuster_protocol::DiagnosticJournal;
#[cfg(target_os = "linux")]
use std::ffi::OsString;
#[cfg(target_os = "linux")]
use std::process::{Command, Stdio};
#[cfg(target_os = "linux")]
use std::time::{Duration, Instant};
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(target_os = "linux")]
const MAX_JOURNAL_BYTES: usize = 192 * 1024;
#[cfg(target_os = "linux")]
const MAX_JOURNAL_LINES: usize = 250;
const MAX_RESPONSE_BYTES: usize = 180 * 1024;
#[cfg(target_os = "linux")]
const JOURNAL_TIMEOUT: Duration = Duration::from_secs(5);

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

pub struct Report {
    pub captured_at_ms: u64,
    pub lines: Vec<String>,
    pub truncated: bool,
    pub journal: DiagnosticJournal,
}

pub fn collect() -> Report {
    let raw_lines = crate::logging::recent_lines();
    let lines: Vec<String> = raw_lines.iter().map(|line| redact(line)).collect();
    let (lines, truncated) = cap_lines(lines, crate::logging::RECENT_LINES);
    let mut report = Report {
        captured_at_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
            .unwrap_or(0),
        lines,
        truncated,
        journal: journal(),
    };
    while serde_json::to_vec(&(&report.lines, &report.journal))
        .map(|bytes| bytes.len() > MAX_RESPONSE_BYTES)
        .unwrap_or(true)
    {
        match &mut report.journal {
            DiagnosticJournal::Available { lines, truncated } if !lines.is_empty() => {
                lines.remove(0);
                *truncated = true;
            }
            _ if !report.lines.is_empty() => {
                report.lines.remove(0);
                report.truncated = true;
            }
            _ => break,
        }
    }
    report
}

fn redact(line: &str) -> String {
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
        line.chars().take(4096).collect()
    }
}

fn cap_lines(lines: Vec<String>, max: usize) -> (Vec<String>, bool) {
    let truncated = lines.len() > max;
    let start = lines.len().saturating_sub(max);
    (lines.into_iter().skip(start).collect(), truncated)
}

fn journal() -> DiagnosticJournal {
    #[cfg(not(target_os = "linux"))]
    {
        return DiagnosticJournal::Unsupported;
    }
    #[cfg(target_os = "linux")]
    {
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
                return DiagnosticJournal::Unavailable {
                    reason: format!("Could not start the fixed journal query: {error}"),
                }
            }
        };
        let Some(mut stdout) = child.stdout.take() else {
            return DiagnosticJournal::Unavailable {
                reason: "The fixed journal query did not provide output".into(),
            };
        };
        let reader = match std::thread::Builder::new()
            .name("journal diagnostics reader".into())
            .spawn(move || {
                use std::io::Read as _;
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
                return DiagnosticJournal::Unavailable {
                    reason: format!("Could not start the journal reader: {error}"),
                };
            }
        };
        let deadline = Instant::now() + JOURNAL_TIMEOUT;
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    let (stdout, truncated) = match reader.join() {
                        Ok(output) => output,
                        Err(_) => {
                            return DiagnosticJournal::Unavailable {
                                reason: "The journal reader stopped unexpectedly".into(),
                            }
                        }
                    };
                    let text = String::from_utf8_lossy(&stdout);
                    let lines: Vec<String> = text.lines().map(redact).collect();
                    let (lines, line_truncated) = cap_lines(lines, MAX_JOURNAL_LINES);
                    if !status.success() {
                        return DiagnosticJournal::Unavailable {
                            reason: format!("The fixed journal query exited with {status}"),
                        };
                    }
                    return DiagnosticJournal::Available {
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
                    return DiagnosticJournal::Unavailable {
                        reason: "The fixed journal query timed out after five seconds".into(),
                    };
                }
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return DiagnosticJournal::Unavailable {
                        reason: format!("Could not check the journal query: {error}"),
                    };
                }
            }
        }
    }
}

#[cfg(test)]
mod diagnostics_tests {
    use super::{cap_lines, journal_arguments, redact};

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
