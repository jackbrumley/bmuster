//! A small logger: one line per record, to stderr (journald adds the time) or,
//! for the Windows service, to a file with a UTC timestamp.
//!
//! Only this program's own records are shown below `warn`, so library debug
//! output (which can include request headers) never reaches the log.
//!
//! The last [`RECENT_LINES`] lines are also kept in memory for the local
//! page (SPEC-AGENT-LOCAL).

use log::{Level, LevelFilter, Log, Metadata, Record};
use std::collections::VecDeque;
use std::fs::File;
use std::io::Write as _;
use std::path::Path;
use std::sync::Mutex;
use std::time::SystemTime;

/// How many log lines the local page can show.
pub const RECENT_LINES: usize = 200;

static RECENT: Mutex<VecDeque<String>> = Mutex::new(VecDeque::new());

fn remember(line: String) {
    let mut recent = RECENT
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if recent.len() == RECENT_LINES {
        recent.pop_front();
    }
    recent.push_back(line);
}

/// The most recent log lines, oldest first, each with its UTC time.
pub fn recent_lines() -> Vec<String> {
    RECENT
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .iter()
        .cloned()
        .collect()
}

enum Sink {
    Stderr,
    #[cfg_attr(not(windows), allow(dead_code))]
    File(Mutex<File>),
}

struct Logger {
    level: LevelFilter,
    sink: Sink,
}

const OWN_TARGETS: [&str; 3] = ["bmuster_agent", "bmuster_protocol", "bmuster_desktop"];

impl Logger {
    fn allows(&self, metadata: &Metadata<'_>) -> bool {
        let own = OWN_TARGETS
            .iter()
            .any(|t| metadata.target() == *t || metadata.target().starts_with(&format!("{t}::")));
        if own {
            metadata.level() <= self.level
        } else {
            metadata.level() <= Level::Warn
        }
    }
}

impl Log for Logger {
    fn enabled(&self, metadata: &Metadata<'_>) -> bool {
        self.allows(metadata)
    }

    fn log(&self, record: &Record<'_>) {
        if !self.allows(record.metadata()) {
            return;
        }
        let level = record.level().as_str();
        remember(format!(
            "{} {level:<5} {}",
            httpdate::fmt_http_date(SystemTime::now()),
            record.args()
        ));
        match &self.sink {
            Sink::Stderr => {
                let _ = writeln!(std::io::stderr(), "{level:<5} {}", record.args());
            }
            Sink::File(file) => {
                let now = httpdate::fmt_http_date(SystemTime::now());
                if let Ok(mut file) = file.lock() {
                    let _ = writeln!(file, "{now} {level:<5} {}", record.args());
                }
            }
        }
    }

    fn flush(&self) {
        if let Sink::File(file) = &self.sink {
            if let Ok(mut file) = file.lock() {
                let _ = file.flush();
            }
        }
    }
}

/// Level from `BMUSTER_LOG` (`error`, `warn`, `info`, `debug`, `trace`); `info` when unset.
fn level_from_env() -> Result<LevelFilter, String> {
    match std::env::var("BMUSTER_LOG") {
        Err(std::env::VarError::NotPresent) => Ok(LevelFilter::Info),
        Err(std::env::VarError::NotUnicode(_)) => Err("BMUSTER_LOG is not valid text".into()),
        Ok(text) => text.parse().map_err(|_| {
            format!("BMUSTER_LOG={text} is not a log level; use error, warn, info, debug or trace")
        }),
    }
}

fn install(logger: Logger) -> Result<(), String> {
    let level = logger.level.max(LevelFilter::Warn);
    log::set_boxed_logger(Box::new(logger)).map_err(|e| e.to_string())?;
    log::set_max_level(level);
    Ok(())
}

pub fn init_stderr() -> Result<(), String> {
    install(Logger {
        level: level_from_env()?,
        sink: Sink::Stderr,
    })
}

/// File log for the Windows service, which has no console.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn init_file(path: &Path) -> Result<(), String> {
    // Moved to `agent.log.old` at start-up once it is over 10 MB.
    let file = bmuster_service::log_file::open_rotated(path)?;
    install(Logger {
        level: level_from_env()?,
        sink: Sink::File(Mutex::new(file)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_last_lines_are_kept() {
        for n in 0..RECENT_LINES + 5 {
            remember(format!("line {n}"));
        }
        let lines = recent_lines();
        assert_eq!(lines.len(), RECENT_LINES);
        assert_eq!(
            lines.last().map(String::as_str),
            Some(format!("line {}", RECENT_LINES + 4).as_str())
        );
    }
}
