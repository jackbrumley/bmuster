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

use crate::log_repeats::Repeats;
use bmuster_protocol::logs::{
    cut_text, LogLevel, LogSource, VerboseLevel, MAX_RECORD_TARGET_BYTES, MAX_RECORD_TEXT_BYTES,
    MAX_VERBOSE_MS,
};
use log::{Level, LevelFilter, Log, Metadata, Record};
use std::collections::VecDeque;
use std::fs::File;
use std::io::Write as _;
use std::path::{Path, PathBuf};
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
    /// Repeats held back and their summaries (SPEC-AGENT-LOGS AL15).
    repeats: Mutex<Repeats>,
}

impl ShipQueue {
    pub const fn new() -> Self {
        Self {
            enabled: AtomicBool::new(false),
            records: Mutex::new(VecDeque::new()),
            dropped: AtomicU64::new(0),
            repeats: Mutex::new(Repeats::new()),
        }
    }

    pub fn enable(&self) {
        self.enabled.store(true, Ordering::SeqCst);
    }

    /// True once the worker turned shipping on.
    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }

    /// Redacts and queues one record (a no-op until shipping is on). A
    /// record identical to one shipped in the last 30 minutes is counted
    /// instead and summarised later.
    pub fn push(&self, level: LogLevel, source: LogSource, target: &str, text: &str) {
        self.push_at(now_ms(), level, source, target, text);
    }

    fn push_at(&self, at: u64, level: LogLevel, source: LogSource, target: &str, text: &str) {
        if !self.enabled.load(Ordering::SeqCst) {
            return;
        }
        let pending = Pending {
            at,
            level,
            source,
            target: cut_text(target, MAX_RECORD_TARGET_BYTES),
            text: cut_text(&crate::diagnostics::redact(text), MAX_RECORD_TEXT_BYTES),
        };
        // The repeats lock is held until the records are queued, so two
        // threads cannot put a summary after the record that closed it.
        let mut repeats = lock(&self.repeats);
        let admitted = repeats.admit(pending);
        self.queue(admitted);
    }

    fn queue(&self, admitted: Vec<Pending>) {
        let mut records = lock(&self.records);
        for pending in admitted {
            if records.len() >= SHIP_QUEUE_LIMIT {
                self.dropped.fetch_add(1, Ordering::SeqCst);
                continue;
            }
            records.push_back(pending);
        }
    }

    /// Everything queued, oldest first, with the summaries of repeats whose
    /// window has ended, and how many records were dropped because the
    /// queue was full.
    pub fn take(&self) -> (Vec<Pending>, u64) {
        self.take_at(now_ms())
    }

    fn take_at(&self, now: u64) -> (Vec<Pending>, u64) {
        {
            let mut repeats = lock(&self.repeats);
            let due = repeats.sweep(now);
            self.queue(due);
        }
        let records = lock(&self.records).drain(..).collect();
        (records, self.dropped.swap(0, Ordering::SeqCst))
    }
}

/// The running agent's ship queue.
pub static SHIP: ShipQueue = ShipQueue::new();

/// For a problem that stays the same for the whole run (a damaged WMI
/// repository): `warn` the first time, `debug` after (SPEC-AGENT-LOGS AL16).
#[cfg_attr(not(windows), allow(dead_code))]
pub struct FirstWarning(AtomicBool);

#[cfg_attr(not(windows), allow(dead_code))]
impl FirstWarning {
    pub const fn new() -> Self {
        Self(AtomicBool::new(false))
    }

    /// The level for this occurrence.
    pub fn level(&self) -> Level {
        if self.0.swap(true, Ordering::SeqCst) {
            Level::Debug
        } else {
            Level::Warn
        }
    }
}

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
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn helper_line(queue: &ShipQueue, helper: &str, line: &str) {
    let _ = writeln!(std::io::stderr(), "INFO  [{helper}] {line}");
    remember(format!(
        "{} INFO  [{helper}] {line}",
        httpdate::fmt_http_date(SystemTime::now())
    ));
    queue.push(LogLevel::Info, LogSource::Helper, helper, line);
}

/// A record with a fixed target (a failed self-check): shown in the agent's
/// own log and shipped under `target`.
pub fn note(queue: &ShipQueue, level: LogLevel, target: &str, text: &str) {
    let label = match level {
        LogLevel::Error => "ERROR",
        LogLevel::Warn => "WARN",
        LogLevel::Info => "INFO",
        LogLevel::Debug => "DEBUG",
        LogLevel::Trace => "TRACE",
    };
    let _ = writeln!(std::io::stderr(), "{label:<5} [{target}] {text}");
    remember(format!(
        "{} {label:<5} [{target}] {text}",
        httpdate::fmt_http_date(SystemTime::now())
    ));
    queue.push(level, LogSource::Agent, target, text);
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

/// The most of a panic's backtrace that is kept (SPEC-DIAGNOSTICS 2).
const MAX_BACKTRACE_BYTES: usize = 16 * 1024;
/// The target of a panic's records.
pub const PANIC_TARGET: &str = "panic";

/// Writes every panic, with its place and a backtrace, into the log spool
/// in `spool_dir` before the process ends, so it ships after the restart.
/// The write is synchronous and goes around the running spool, which the
/// panicking thread may hold.
pub fn install_panic_hook(spool_dir: PathBuf) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let message = panic_message(info);
        let location = info
            .location()
            .map(|place| format!("{}:{}", place.file(), place.line()))
            .unwrap_or_default();
        let thread = std::thread::current()
            .name()
            .unwrap_or("unnamed")
            .to_string();
        let backtrace = std::backtrace::Backtrace::force_capture().to_string();
        for record in panic_records(&message, &location, &thread, &backtrace, now_ms()) {
            let _ = crate::log_spool::leave_record(&spool_dir, &record);
        }
        previous(info);
    }));
}

/// A panic's message, when it has one.
fn panic_message(info: &std::panic::PanicHookInfo<'_>) -> String {
    let payload = info.payload();
    payload
        .downcast_ref::<&str>()
        .map(|text| (*text).to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "(no message)".to_string())
}

/// For the Windows desktop helper, whose log file the service ships: each
/// panic goes into that log as `error` lines before the process ends.
#[cfg(windows)]
pub fn install_logged_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let backtrace = std::backtrace::Backtrace::force_capture().to_string();
        let location = info
            .location()
            .map(|place| format!("{}:{}", place.file(), place.line()))
            .unwrap_or_default();
        let thread = std::thread::current()
            .name()
            .unwrap_or("unnamed")
            .to_string();
        let message = panic_message(info);
        for record in panic_records(&message, &location, &thread, &backtrace, now_ms()) {
            log::error!("{}", record.text);
        }
        log::logger().flush();
        previous(info);
    }));
}

/// A panic as `error` records: the first says what and where, with the
/// start of the backtrace; the rest carry the backtrace (at most
/// [`MAX_BACKTRACE_BYTES`]), each within a record's text limit.
fn panic_records(
    message: &str,
    location: &str,
    thread: &str,
    backtrace: &str,
    at: u64,
) -> Vec<Pending> {
    let backtrace = cut_text(backtrace, MAX_BACKTRACE_BYTES);
    let mut parts: Vec<String> = Vec::new();
    let mut part = String::new();
    let room = MAX_RECORD_TEXT_BYTES - 256;
    for line in backtrace.lines() {
        if !part.is_empty() && part.len() + line.len() + 1 > room {
            parts.push(std::mem::take(&mut part));
        }
        part.push_str(&cut_text(line, room));
        part.push('\n');
    }
    if !part.is_empty() {
        parts.push(part);
    }
    let count = parts.len().max(1);
    let head = cut_text(
        &format!("The agent panicked in thread {thread} at {location}: {message}"),
        1024,
    );
    let mut texts = vec![format!(
        "{head}\nBacktrace (1 of {count}):\n{}",
        parts.first().map_or("", String::as_str)
    )];
    for (index, part) in parts.iter().enumerate().skip(1) {
        texts.push(format!("Backtrace ({} of {count}):\n{part}", index + 1));
    }
    texts
        .into_iter()
        .map(|text| Pending {
            at,
            level: LogLevel::Error,
            source: LogSource::Agent,
            target: PANIC_TARGET.into(),
            text: cut_text(text.trim_end(), MAX_RECORD_TEXT_BYTES),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Names the spool folder for [`panic_hook_child`], and tells it that
    /// it runs as the child of [`panic_is_spooled_before_exit`].
    const PANIC_CHILD_SPOOL: &str = "BMUSTER_TEST_PANIC_SPOOL";

    /// SPEC-DIAGNOSTICS D5.
    ///
    /// The panic hook is process-wide, and other tests in this binary panic
    /// on purpose (a check that panics, a session thread that fails). With
    /// the hook installed here, a panic from a test running alongside wrote
    /// its own records into this spool, so the first record or the count
    /// was sometimes not ours. The panic therefore runs in a child test
    /// process that runs nothing else.
    #[test]
    fn panic_is_spooled_before_exit() {
        let dir = tempfile::tempdir().unwrap();
        let spool_dir = dir.path().join("logs");
        let child = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "logging::tests::panic_hook_child",
                "--ignored",
                "--test-threads=1",
                "--nocapture",
            ])
            .env(PANIC_CHILD_SPOOL, &spool_dir)
            .output()
            .unwrap();
        let child_output = String::from_utf8_lossy(&child.stdout);
        assert!(child.status.success(), "{child_output}");
        assert!(
            child_output.contains("1 passed"),
            "the child ran the panic: {child_output}"
        );

        // The records are on disk already; the next start ships them.
        let spool =
            crate::log_spool::Spool::open(&spool_dir, "00000000-0000-4000-8000-000000000001")
                .unwrap();
        let (_, records) = spool.next_batch(500).unwrap();
        let ours: Vec<_> = records
            .iter()
            .filter(|record| record.target == PANIC_TARGET)
            .collect();
        assert!(!ours.is_empty(), "{records:?}");
        assert!(ours.iter().all(|record| record.level == LogLevel::Error));
        assert!(
            ours[0].text.contains("[redacted diagnostic line]"),
            "the message names a token, so its line is redacted: {}",
            ours[0].text
        );
        assert!(ours[0].text.contains("Backtrace (1 of"), "{}", ours[0].text);
        assert!(ours
            .iter()
            .all(|record| record.text.len() <= MAX_RECORD_TEXT_BYTES));
        let again =
            crate::log_spool::Spool::open(&spool_dir, "00000000-0000-4000-8000-000000000002")
                .unwrap();
        assert_eq!(
            again.next_batch(500).map(|(_, r)| r.len()),
            Some(records.len()),
            "taken in once: the left files are gone, the records wait in the spool"
        );
    }

    /// The panicking half of [`panic_is_spooled_before_exit`], run by it in
    /// a process of its own.
    #[test]
    #[ignore = "run by panic_is_spooled_before_exit in a process of its own"]
    fn panic_hook_child() {
        // `cargo test -- --ignored` runs it too, with no spool named: the
        // test is then only meant as the child, so it has nothing to do.
        let Some(spool_dir) = std::env::var_os(PANIC_CHILD_SPOOL) else {
            return;
        };
        install_panic_hook(PathBuf::from(spool_dir));
        let crashed = std::thread::Builder::new()
            .name("crasher".into())
            .spawn(|| panic!("check panic 4711 token=abc"))
            .unwrap()
            .join();
        assert!(crashed.is_err());
    }

    #[test]
    fn a_panic_is_split_within_the_record_limit() {
        let backtrace: String = (0..2000)
            .map(|n| format!("  {n}: frame::function_{n}\n"))
            .collect();
        let records = panic_records("boom", "src/main.rs:1", "main", &backtrace, 5);
        assert!(records.len() > 1);
        assert!(records[0]
            .text
            .starts_with("The agent panicked in thread main at src/main.rs:1: boom"));
        let total: usize = records.iter().map(|r| r.text.len()).sum();
        assert!(
            total <= MAX_BACKTRACE_BYTES + 4 * 1024 + records.len() * 64,
            "{total}"
        );
        assert!(records
            .iter()
            .all(|r| r.text.len() <= MAX_RECORD_TEXT_BYTES));
    }

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
    fn ship_queue_collapses_repeats() {
        let queue = leaked(ShipQueue::new());
        queue.enable();
        let text = "Check-in failed: HTTP 502 Bad Gateway; retrying in 60 s";
        for minute in 0..10 {
            queue.push_at(
                minute * 60_000,
                LogLevel::Warn,
                LogSource::Agent,
                "bmuster_agent::worker",
                text,
            );
        }
        assert_eq!(
            queue.take_at(10 * 60_000).0.len(),
            1,
            "repeats are held back"
        );
        let (due, _) = queue.take_at(30 * 60_000);
        assert_eq!(due.len(), 1);
        assert_eq!(
            due[0].text,
            format!("Repeated 9 more times in the last 30 minutes: {text}")
        );
    }

    #[test]
    fn first_warning_then_debug() {
        let once = FirstWarning::new();
        assert_eq!(once.level(), Level::Warn);
        assert_eq!(once.level(), Level::Debug);
        assert_eq!(once.level(), Level::Debug);
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
