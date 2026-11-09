//! A small logger: one line per record, to stderr (journald adds the time) or,
//! for the Windows service, to a file with a UTC timestamp.
//!
//! Only this program's own records are shown below `warn`, so library debug
//! output (which can include request headers) never reaches the log.
//!
//! The last [`RECENT_LINES`] lines are also kept in memory for the local
//! page (SPEC-AGENT-LOCAL), and every record the logger lets through is
//! redacted and put in the ship queue, which the worker moves into its spool
//! and sends to the server (SPEC-AGENT-LOGS 1).
//!
//! The server can make the agent's own targets verbose (`debug`) until a
//! deadline; library targets stay at `warn`. The window lives in memory only,
//! so a restart is back at the normal level.

use bmuster_protocol::logs::{
    cut_text, LogLevel, LogSource, VerboseLevel, MAX_RECORD_TARGET_BYTES, MAX_RECORD_TEXT_BYTES,
    MAX_VERBOSE_MS,
};
use log::{Level, LevelFilter, Log, Metadata, Record};
use std::collections::VecDeque;
use std::fs::File;
use std::io::Write as _;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// How many log lines the local page can show.
pub const RECENT_LINES: usize = 200;
/// Records waiting for the spool; more are counted as dropped.
const SHIP_QUEUE_LIMIT: usize = 5000;

static RECENT: Mutex<VecDeque<String>> = Mutex::new(VecDeque::new());

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn remember(line: String) {
    let mut recent = lock(&RECENT);
    if recent.len() == RECENT_LINES {
        recent.pop_front();
    }
    recent.push_back(line);
}

/// The most recent log lines, oldest first, each with its UTC time.
pub fn recent_lines() -> Vec<String> {
    lock(&RECENT).iter().cloned().collect()
}

/// Unix milliseconds now.
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

/// This process's id in shipped records: a random UUID made once per start.
pub fn instance() -> &'static str {
    static INSTANCE: OnceLock<String> = OnceLock::new();
    INSTANCE.get_or_init(|| {
        let mut bytes = [0_u8; 16];
        if getrandom::getrandom(&mut bytes).is_err() {
            // No randomness: the time still separates one start from the next.
            bytes[..8].copy_from_slice(&now_ms().to_be_bytes());
        }
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        let hex = hex::encode(bytes);
        format!(
            "{}-{}-{}-{}-{}",
            &hex[0..8],
            &hex[8..12],
            &hex[12..16],
            &hex[16..20],
            &hex[20..32]
        )
    })
}

/// A record waiting for the spool, which gives it its sequence number.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pending {
    pub at: u64,
    pub level: LogLevel,
    pub source: LogSource,
    pub target: String,
    pub text: String,
}

/// Records on their way to the spool. Only the worker turns shipping on, so
/// other commands (the tray, helpers) never fill it.
pub struct ShipQueue {
    enabled: AtomicBool,
    records: Mutex<VecDeque<Pending>>,
    dropped: AtomicU64,
}

impl ShipQueue {
    pub const fn new() -> Self {
        Self {
            enabled: AtomicBool::new(false),
            records: Mutex::new(VecDeque::new()),
            dropped: AtomicU64::new(0),
        }
    }

    pub fn enable(&self) {
        self.enabled.store(true, Ordering::SeqCst);
    }

    /// Redacts and queues one record (a no-op until shipping is on).
    pub fn push(&self, level: LogLevel, source: LogSource, target: &str, text: &str) {
        if !self.enabled.load(Ordering::SeqCst) {
            return;
        }
        let pending = Pending {
            at: now_ms(),
            level,
            source,
            target: cut_text(target, MAX_RECORD_TARGET_BYTES),
            text: cut_text(&crate::diagnostics::redact(text), MAX_RECORD_TEXT_BYTES),
        };
        let mut records = lock(&self.records);
        if records.len() >= SHIP_QUEUE_LIMIT {
            self.dropped.fetch_add(1, Ordering::SeqCst);
            return;
        }
        records.push_back(pending);
    }

    /// Everything queued, oldest first, and how many records were dropped
    /// because the queue was full.
    pub fn take(&self) -> (Vec<Pending>, u64) {
        let records = lock(&self.records).drain(..).collect();
        (records, self.dropped.swap(0, Ordering::SeqCst))
    }
}

/// The running agent's ship queue.
pub static SHIP: ShipQueue = ShipQueue::new();

/// The logger's level for the agent's own targets, and the verbose window.
pub struct Filter {
    /// `LevelFilter` as a number (`Off` = 0 … `Trace` = 5).
    base: AtomicUsize,
    /// Unix milliseconds until which own targets log `debug`; 0 for none.
    verbose_until_ms: AtomicU64,
}

impl Filter {
    pub const fn new() -> Self {
        Self {
            base: AtomicUsize::new(LevelFilter::Info as usize),
            verbose_until_ms: AtomicU64::new(0),
        }
    }

    fn base(&self) -> LevelFilter {
        match self.base.load(Ordering::SeqCst) {
            0 => LevelFilter::Off,
            1 => LevelFilter::Error,
            2 => LevelFilter::Warn,
            3 => LevelFilter::Info,
            4 => LevelFilter::Debug,
            _ => LevelFilter::Trace,
        }
    }

    fn set_base(&self, level: LevelFilter) {
        self.base.store(level as usize, Ordering::SeqCst);
    }

    /// The level for the agent's own targets at `now`.
    fn own_level(&self, now: u64) -> LevelFilter {
        let base = self.base();
        if now < self.verbose_until_ms.load(Ordering::SeqCst) {
            base.max(LevelFilter::Debug)
        } else {
            base
        }
    }

    fn allows(&self, metadata: &Metadata<'_>, now: u64) -> bool {
        if is_own(metadata.target()) {
            metadata.level() <= self.own_level(now)
        } else {
            metadata.level() <= Level::Warn
        }
    }

    /// `log-level` from the server: debug until a deadline (at most four
    /// hours ahead), or back to the normal level. Returns the highest level
    /// the logger may now let through.
    pub fn set_verbose(&self, level: VerboseLevel, now: u64) -> LevelFilter {
        match level {
            VerboseLevel::Debug { until_ms } => {
                let until = until_ms.min(now.saturating_add(MAX_VERBOSE_MS));
                self.verbose_until_ms.store(until, Ordering::SeqCst);
            }
            VerboseLevel::Info => self.verbose_until_ms.store(0, Ordering::SeqCst),
        }
        self.own_level(now).max(LevelFilter::Warn)
    }
}

/// The running agent's filter.
static FILTER: Filter = Filter::new();

/// `log-level` from the server, applied to the running logger.
pub fn set_verbose(level: VerboseLevel) {
    let now = now_ms();
    match level {
        VerboseLevel::Debug { until_ms } if until_ms > now => log::info!(
            "Verbose logging for {} minutes, as the server asked.",
            (until_ms - now).min(MAX_VERBOSE_MS) / 60_000
        ),
        _ => log::info!("Back to normal logging, as the server asked."),
    }
    // The window ends by itself (`own_level`); the global maximum only lets
    // debug records reach the filter.
    log::set_max_level(FILTER.set_verbose(level, now).max(LevelFilter::Debug));
}

enum Sink {
    Stderr,
    #[cfg_attr(not(windows), allow(dead_code))]
    File(Mutex<File>),
}

struct Logger {
    filter: &'static Filter,
    queue: &'static ShipQueue,
    sink: Sink,
}

const OWN_TARGETS: [&str; 3] = ["bmuster_agent", "bmuster_protocol", "bmuster_desktop"];

fn is_own(target: &str) -> bool {
    OWN_TARGETS
        .iter()
        .any(|t| target == *t || target.starts_with(&format!("{t}::")))
}

fn level_of(level: Level) -> LogLevel {
    match level {
        Level::Error => LogLevel::Error,
        Level::Warn => LogLevel::Warn,
        Level::Info => LogLevel::Info,
        Level::Debug => LogLevel::Debug,
        Level::Trace => LogLevel::Trace,
    }
}

impl Logger {
    fn write(&self, level: &str, text: &str) {
        remember(format!(
            "{} {level:<5} {text}",
            httpdate::fmt_http_date(SystemTime::now()),
        ));
        match &self.sink {
            Sink::Stderr => {
                let _ = writeln!(std::io::stderr(), "{level:<5} {text}");
            }
            Sink::File(file) => {
                let now = httpdate::fmt_http_date(SystemTime::now());
                if let Ok(mut file) = file.lock() {
                    let _ = writeln!(file, "{now} {level:<5} {text}");
                }
            }
        }
    }
}

impl Log for Logger {
    fn enabled(&self, metadata: &Metadata<'_>) -> bool {
        self.filter.allows(metadata, now_ms())
    }

    fn log(&self, record: &Record<'_>) {
        if !self.filter.allows(record.metadata(), now_ms()) {
            return;
        }
        let text = record.args().to_string();
        self.write(record.level().as_str(), &text);
        self.queue.push(
            level_of(record.level()),
            LogSource::Agent,
            record.target(),
            &text,
        );
    }

    fn flush(&self) {
        if let Sink::File(file) = &self.sink {
            if let Ok(mut file) = file.lock() {
                let _ = file.flush();
            }
        }
    }
}

/// One line of a helper's stderr: shown in the agent's own log as before,
/// and shipped with the helper's name as its target.
pub fn helper_line(queue: &ShipQueue, helper: &str, line: &str) {
    let _ = writeln!(std::io::stderr(), "INFO  [{helper}] {line}");
    remember(format!(
        "{} INFO  [{helper}] {line}",
        httpdate::fmt_http_date(SystemTime::now())
    ));
    queue.push(LogLevel::Info, LogSource::Helper, helper, line);
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

fn install(sink: Sink) -> Result<(), String> {
    let level = level_from_env()?;
    FILTER.set_base(level);
    log::set_boxed_logger(Box::new(Logger {
        filter: &FILTER,
        queue: &SHIP,
        sink,
    }))
    .map_err(|e| e.to_string())?;
    log::set_max_level(level.max(LevelFilter::Warn));
    Ok(())
}

pub fn init_stderr() -> Result<(), String> {
    install(Sink::Stderr)
}

/// File log for the Windows service, which has no console.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn init_file(path: &Path) -> Result<(), String> {
    // Moved to `agent.log.old` at start-up once it is over 10 MB.
    let file = bmuster_service::log_file::open_rotated(path)?;
    install(Sink::File(Mutex::new(file)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn leaked<T>(value: T) -> &'static T {
        Box::leak(Box::new(value))
    }

    fn logger(queue: &'static ShipQueue, filter: &'static Filter) -> Logger {
        Logger {
            filter,
            queue,
            sink: Sink::Stderr,
        }
    }

    fn log_to(logger: &Logger, target: &str, level: Level, text: &str) {
        logger.log(
            &Record::builder()
                .target(target)
                .level(level)
                .args(format_args!("{text}"))
                .build(),
        );
    }

    #[test]
    fn only_the_last_lines_are_kept() {
        for n in 0..RECENT_LINES + 5 {
            remember(format!("line {n}"));
        }
        let lines = recent_lines();
        assert_eq!(lines.len(), RECENT_LINES);
        assert!(lines
            .iter()
            .any(|line| line.ends_with(&format!("line {}", RECENT_LINES + 4))));
    }

    #[test]
    fn ship_queue_takes_own_records_redacted() {
        let queue = leaked(ShipQueue::new());
        let logger = logger(queue, leaked(Filter::new()));

        log_to(
            &logger,
            "bmuster_agent::socket",
            Level::Info,
            "before shipping",
        );
        assert_eq!(
            queue.take().0,
            vec![],
            "nothing is queued until the worker turns it on"
        );
        queue.enable();

        log_to(
            &logger,
            "bmuster_agent::socket",
            Level::Info,
            "Live socket connected.",
        );
        log_to(
            &logger,
            "bmuster_agent::socket",
            Level::Debug,
            "own debug, not verbose",
        );
        log_to(&logger, "rustls::client", Level::Info, "library info");
        log_to(&logger, "ureq::unit", Level::Debug, "authorization: secret");
        log_to(&logger, "rustls::client", Level::Warn, "library warning");
        log_to(
            &logger,
            "bmuster_agent::client",
            Level::Warn,
            "token=abc123 refused",
        );
        log_to(
            &logger,
            "bmuster_desktop::capture",
            Level::Info,
            &"x".repeat(9000),
        );

        let (records, dropped) = queue.take();
        assert_eq!(dropped, 0);
        let shown: Vec<(LogLevel, &str, &str)> = records
            .iter()
            .map(|r| (r.level, r.target.as_str(), r.text.as_str()))
            .collect();
        assert_eq!(shown.len(), 4, "{shown:?}");
        assert_eq!(
            shown[0],
            (
                LogLevel::Info,
                "bmuster_agent::socket",
                "Live socket connected."
            )
        );
        assert_eq!(
            shown[1],
            (LogLevel::Warn, "rustls::client", "library warning")
        );
        assert_eq!(
            shown[2],
            (
                LogLevel::Warn,
                "bmuster_agent::client",
                "[redacted diagnostic line]"
            )
        );
        assert!(shown[3].2.len() <= MAX_RECORD_TEXT_BYTES);
        assert!(shown[3].2.ends_with("[cut 9000 bytes]"));
        assert!(records.iter().all(|r| r.source == LogSource::Agent));
    }

    #[test]
    fn verbose_window_ends() {
        let filter = leaked(Filter::new());
        let queue = leaked(ShipQueue::new());
        queue.enable();
        let logger = logger(queue, filter);
        let now = now_ms();
        let own = Metadata::builder()
            .target("bmuster_agent::sessions")
            .level(Level::Debug)
            .build();
        let library = Metadata::builder()
            .target("tungstenite::protocol")
            .level(Level::Info)
            .build();

        assert!(!filter.allows(&own, now));
        // Asking for more than four hours gets four hours.
        filter.set_verbose(
            VerboseLevel::Debug {
                until_ms: now + 10 * MAX_VERBOSE_MS,
            },
            now,
        );
        assert!(filter.allows(&own, now));
        assert!(filter.allows(&own, now + MAX_VERBOSE_MS - 1));
        assert!(
            !filter.allows(&own, now + MAX_VERBOSE_MS),
            "ends at its deadline"
        );
        assert!(
            !filter.allows(&library, now),
            "library targets stay at warn"
        );

        log_to(
            &logger,
            "bmuster_agent::sessions",
            Level::Debug,
            "verbose detail",
        );
        assert_eq!(queue.take().0.len(), 1, "debug records ship while verbose");

        filter.set_verbose(VerboseLevel::Info, now);
        assert!(!filter.allows(&own, now), "info ends it at once");

        filter.set_verbose(
            VerboseLevel::Debug {
                until_ms: now + 60_000,
            },
            now,
        );
        assert!(
            !Filter::new().allows(&own, now),
            "a restart starts at the normal level"
        );
    }
}
