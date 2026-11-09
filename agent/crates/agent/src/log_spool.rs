//! The log spool (SPEC-AGENT-LOGS 1): shipped records wait on disk in
//! `<data>/logs/spool-<n>.jsonl` until the server acknowledges them, so logs
//! from a crash or an outage still arrive.
//!
//! - Segments are at most 256 KiB, the spool at most 5 MiB: the oldest
//!   segment goes first, and what it held is reported once as a dropped record.
//! - `acked.json` names the first unacknowledged line, so acknowledged records
//!   are not sent again after a restart.
//! - At most 3000 records a minute enter the spool; the excess is counted and
//!   reported once a minute. Sending is paced to the same rate, so a backlog
//!   drains without tripping the server's limit.
//! - Files are private (0600) in a private folder (0700).

use crate::logging::{now_ms, Pending, ShipQueue};
use bmuster_protocol::logs::{LogLevel, LogRecord, LogSource, MAX_BATCH_BYTES, MAX_BATCH_RECORDS};
use bmuster_protocol::AgentMessage;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::fs::{self, OpenOptions};
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const SEGMENT_BYTES: u64 = 256 * 1024;
pub const SPOOL_BYTES: u64 = 5 * 1024 * 1024;
pub const RECORDS_PER_MINUTE: u64 = 3000;
const MINUTE_MS: u64 = 60_000;
const CURSOR_FILE: &str = "acked.json";
/// The folder under the data folder.
pub const SPOOL_DIR: &str = "logs";
/// A batch the server has not acknowledged in this long is sent again.
const ACK_TIMEOUT: Duration = Duration::from_secs(30);
/// How often the queue is moved into the spool.
const FLUSH_EVERY: Duration = Duration::from_millis(250);
const DROPPED_TARGET: &str = "dropped";

/// One line of a segment file.
#[derive(Serialize, Deserialize)]
struct Line {
    instance: String,
    #[serde(flatten)]
    record: LogRecord,
}

/// Files of records left for the next worker start with this.
const LEFT_PREFIX: &str = "left-";

/// A record left in the spool folder by a process that cannot reach the
/// running spool: the panic hook (the process is about to end) and the
/// launcher (between workers). SPEC-DIAGNOSTICS 2.
#[derive(Serialize, Deserialize)]
struct Left {
    at: u64,
    level: LogLevel,
    source: LogSource,
    target: String,
    text: String,
}

/// Writes `record` synchronously as its own file in the spool folder `dir`;
/// the next [`Spool::open`] takes it in and ships it. Redacted and cut like
/// every queued record.
pub fn leave_record(dir: &Path, record: &Pending) -> io::Result<()> {
    use std::sync::atomic::AtomicU64;
    static NEXT: AtomicU64 = AtomicU64::new(0);
    make_private_dir(dir)?;
    let left = Left {
        at: record.at,
        level: record.level,
        source: record.source,
        target: bmuster_protocol::logs::cut_text(
            &record.target,
            bmuster_protocol::logs::MAX_RECORD_TARGET_BYTES,
        ),
        text: bmuster_protocol::logs::cut_text(
            &crate::diagnostics::redact_lines(&record.text),
            bmuster_protocol::logs::MAX_RECORD_TEXT_BYTES,
        ),
    };
    // Sorted by name is oldest first: the time, then this process's count.
    let name = format!(
        "{LEFT_PREFIX}{:015}-{:010}-{:06}.json",
        record.at,
        std::process::id(),
        NEXT.fetch_add(1, Ordering::SeqCst)
    );
    let temporary = dir.join(format!("{name}.new"));
    {
        let mut options = OpenOptions::new();
        options.create(true).write(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        file.write_all(&serde_json::to_vec(&left)?)?;
        file.sync_all()?;
    }
    fs::rename(temporary, dir.join(name))
}

/// The first line not yet acknowledged.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
struct Cursor {
    segment: u64,
    line: u64,
}

struct Held {
    segment: u64,
    line: u64,
    instance: String,
    record: LogRecord,
}

struct Segment {
    n: u64,
    bytes: u64,
    lines: u64,
}

/// Records allowed into the spool per minute; the excess is counted.
struct MinuteLimit {
    started_ms: u64,
    count: u64,
    excess: u64,
}

impl MinuteLimit {
    /// The excess of a minute that has ended, if any, to report.
    fn roll(&mut self, now: u64) -> u64 {
        if now.saturating_sub(self.started_ms) < MINUTE_MS {
            return 0;
        }
        self.started_ms = now;
        self.count = 0;
        std::mem::take(&mut self.excess)
    }

    fn admit(&mut self) -> bool {
        if self.count < RECORDS_PER_MINUTE {
            self.count += 1;
            true
        } else {
            self.excess += 1;
            false
        }
    }
}

pub struct Spool {
    dir: PathBuf,
    instance: String,
    next_seq: u64,
    /// Oldest first; the last is the one being written.
    segments: VecDeque<Segment>,
    /// Not yet acknowledged, oldest first.
    held: VecDeque<Held>,
    limit: MinuteLimit,
}

fn segment_path(dir: &Path, n: u64) -> PathBuf {
    dir.join(format!("spool-{n}.jsonl"))
}

fn segment_number(name: &str) -> Option<u64> {
    name.strip_prefix("spool-")?
        .strip_suffix(".jsonl")?
        .parse()
        .ok()
}

#[cfg(unix)]
fn make_private_dir(dir: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt as _;
    fs::create_dir_all(dir)?;
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn make_private_dir(dir: &Path) -> io::Result<()> {
    // The data folder's own access rules cover it on Windows.
    fs::create_dir_all(dir)
}

fn open_private_append(path: &Path) -> io::Result<fs::File> {
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    options.open(path)
}

impl Spool {
    /// Opens the spool in `dir`, keeping what an earlier run left unacknowledged.
    pub fn open(dir: &Path, instance: &str) -> io::Result<Self> {
        make_private_dir(dir)?;
        let cursor = fs::read(dir.join(CURSOR_FILE))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Cursor>(&bytes).ok())
            .unwrap_or(Cursor {
                segment: 0,
                line: 0,
            });
        let mut numbers: Vec<u64> = fs::read_dir(dir)?
            .flatten()
            .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
            .filter_map(|entry| segment_number(&entry.file_name().to_string_lossy()))
            .collect();
        numbers.sort_unstable();
        let mut segments = VecDeque::new();
        let mut held = VecDeque::new();
        for n in numbers {
            let path = segment_path(dir, n);
            if n < cursor.segment {
                fs::remove_file(&path)?;
                continue;
            }
            let text = fs::read(&path)?;
            let mut lines = 0;
            for (index, line) in text.split(|byte| *byte == b'\n').enumerate() {
                if line.is_empty() {
                    continue;
                }
                let index = index as u64;
                lines = index + 1;
                if n == cursor.segment && index < cursor.line {
                    continue;
                }
                // A line cut short by a crash is skipped.
                if let Ok(parsed) = serde_json::from_slice::<Line>(line) {
                    held.push_back(Held {
                        segment: n,
                        line: index,
                        instance: parsed.instance,
                        record: parsed.record,
                    });
                }
            }
            segments.push_back(Segment {
                n,
                bytes: text.len() as u64,
                lines,
            });
        }
        let next = segments.back().map_or(1, |segment| segment.n + 1);
        segments.push_back(Segment {
            n: next,
            bytes: 0,
            lines: 0,
        });
        let mut spool = Self {
            dir: dir.to_path_buf(),
            instance: instance.to_string(),
            next_seq: 1,
            segments,
            held,
            limit: MinuteLimit {
                started_ms: now_ms(),
                count: 0,
                excess: 0,
            },
        };
        spool.take_left_records()?;
        Ok(spool)
    }

    /// Moves records that a crashed process or the launcher left
    /// ([`leave_record`]) into the spool, oldest first.
    fn take_left_records(&mut self) -> io::Result<()> {
        let mut left: Vec<PathBuf> = fs::read_dir(&self.dir)?
            .flatten()
            .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with(LEFT_PREFIX) && name.ends_with(".json"))
            })
            .collect();
        left.sort();
        for path in left {
            // One that cannot be read (cut short by the crash) is dropped.
            if let Ok(record) = fs::read(&path)
                .map_err(io::Error::other)
                .and_then(|bytes| serde_json::from_slice::<Left>(&bytes).map_err(io::Error::other))
            {
                self.write(Pending {
                    at: record.at,
                    level: record.level,
                    source: record.source,
                    target: record.target,
                    text: record.text,
                })?;
            }
            fs::remove_file(&path)?;
        }
        Ok(())
    }

    fn total_bytes(&self) -> u64 {
        self.segments.iter().map(|segment| segment.bytes).sum()
    }

    /// Moves queued records into the spool, giving them this process's
    /// sequence numbers. `queue_dropped` records were lost before the spool.
    pub fn append(
        &mut self,
        pending: Vec<Pending>,
        queue_dropped: u64,
        now: u64,
    ) -> io::Result<()> {
        if queue_dropped > 0 {
            self.note(
                now,
                &format!("{queue_dropped} log records were dropped: the agent's queue was full."),
            )?;
        }
        let excess = self.limit.roll(now);
        if excess > 0 {
            self.note(
                now,
                &format!("{excess} log records were dropped: more than {RECORDS_PER_MINUTE} in a minute."),
            )?;
        }
        for record in pending {
            if self.limit.admit() {
                self.write(record)?;
            }
        }
        Ok(())
    }

    fn note(&mut self, now: u64, text: &str) -> io::Result<()> {
        self.write(Pending {
            at: now,
            level: LogLevel::Warn,
            source: LogSource::Agent,
            target: DROPPED_TARGET.into(),
            text: text.into(),
        })
    }

    fn write(&mut self, pending: Pending) -> io::Result<()> {
        let mut next = Some(pending);
        while let Some(pending) = next.take() {
            let record = LogRecord {
                seq: self.next_seq,
                at: pending.at,
                level: pending.level,
                source: pending.source,
                target: pending.target,
                text: pending.text,
            };
            let mut line = serde_json::to_vec(&Line {
                instance: self.instance.clone(),
                record: record.clone(),
            })?;
            line.push(b'\n');
            let size = line.len() as u64;
            if let Some(current) = self.segments.back() {
                if current.lines > 0 && current.bytes + size > SEGMENT_BYTES {
                    let n = current.n + 1;
                    self.segments.push_back(Segment {
                        n,
                        bytes: 0,
                        lines: 0,
                    });
                }
            }
            let mut dropped = 0;
            while self.total_bytes() + size > SPOOL_BYTES && self.segments.len() > 1 {
                dropped += self.drop_oldest()?;
            }
            let Some(current) = self.segments.back_mut() else {
                return Err(io::Error::other("the spool has no segment"));
            };
            open_private_append(&segment_path(&self.dir, current.n))?.write_all(&line)?;
            self.held.push_back(Held {
                segment: current.n,
                line: current.lines,
                instance: self.instance.clone(),
                record,
            });
            current.bytes += size;
            current.lines += 1;
            self.next_seq += 1;
            if dropped > 0 {
                next = Some(Pending {
                    at: now_ms(),
                    level: LogLevel::Warn,
                    source: LogSource::Agent,
                    target: DROPPED_TARGET.into(),
                    text: format!(
                        "{dropped} log records were dropped: the spool reached its 5 MiB limit."
                    ),
                });
            }
        }
        Ok(())
    }

    /// Deletes the oldest segment; returns how many unacknowledged records went with it.
    fn drop_oldest(&mut self) -> io::Result<u64> {
        let Some(oldest) = self.segments.pop_front() else {
            return Ok(0);
        };
        match fs::remove_file(segment_path(&self.dir, oldest.n)) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
            _ => {}
        }
        let before = self.held.len();
        self.held.retain(|held| held.segment != oldest.n);
        self.save_cursor()?;
        Ok((before - self.held.len()) as u64)
    }

    /// The oldest unacknowledged records of one process: at most
    /// `max_records` (and [`MAX_BATCH_RECORDS`]) and [`MAX_BATCH_BYTES`] of JSON.
    pub fn next_batch(&self, max_records: usize) -> Option<(String, Vec<LogRecord>)> {
        let instance = self.held.front()?.instance.clone();
        let mut bytes = 0;
        let mut records = Vec::new();
        for held in &self.held {
            if held.instance != instance || records.len() >= max_records.min(MAX_BATCH_RECORDS) {
                break;
            }
            let size =
                serde_json::to_vec(&held.record).map_or(MAX_BATCH_BYTES, |json| json.len()) + 1;
            if !records.is_empty() && bytes + size > MAX_BATCH_BYTES {
                break;
            }
            bytes += size;
            records.push(held.record.clone());
        }
        (!records.is_empty()).then_some((instance, records))
    }

    /// The server stored `instance`'s records up to `seq`: they leave the spool.
    pub fn ack(&mut self, instance: &str, seq: u64) -> io::Result<usize> {
        let mut removed = 0;
        while self
            .held
            .front()
            .is_some_and(|held| held.instance == instance && held.record.seq <= seq)
        {
            self.held.pop_front();
            removed += 1;
        }
        if removed > 0 {
            let first = self.cursor().segment;
            while self.segments.len() > 1 && self.segments.front().is_some_and(|s| s.n < first) {
                if let Some(segment) = self.segments.pop_front() {
                    match fs::remove_file(segment_path(&self.dir, segment.n)) {
                        Err(error) if error.kind() != io::ErrorKind::NotFound => return Err(error),
                        _ => {}
                    }
                }
            }
            self.save_cursor()?;
        }
        Ok(removed)
    }

    fn cursor(&self) -> Cursor {
        match (self.held.front(), self.segments.back()) {
            (Some(held), _) => Cursor {
                segment: held.segment,
                line: held.line,
            },
            (None, Some(current)) => Cursor {
                segment: current.n,
                line: current.lines,
            },
            (None, None) => Cursor {
                segment: 0,
                line: 0,
            },
        }
    }

    fn save_cursor(&self) -> io::Result<()> {
        let temporary = self.dir.join(format!("{CURSOR_FILE}.new"));
        {
            let mut file = OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .open(&temporary)?;
            file.write_all(&serde_json::to_vec(&self.cursor())?)?;
        }
        fs::rename(temporary, self.dir.join(CURSOR_FILE))
    }
}

/// Sends at most [`RECORDS_PER_MINUTE`] a minute, refilled continuously.
struct Pace {
    tokens: f64,
    at: Instant,
}

impl Pace {
    fn available(&mut self, now: Instant) -> usize {
        let refill = now.saturating_duration_since(self.at).as_secs_f64()
            * (RECORDS_PER_MINUTE as f64 / 60.0);
        self.tokens = (self.tokens + refill).min(RECORDS_PER_MINUTE as f64);
        self.at = now;
        self.tokens.floor() as usize
    }

    fn spend(&mut self, records: usize) {
        self.tokens -= records as f64;
    }
}

struct InFlight {
    instance: String,
    sent: Instant,
}

/// The spool and what is on its way to the server, shared by the flusher
/// thread and the live socket.
pub struct Shipper {
    spool: Mutex<Spool>,
    in_flight: Mutex<Option<InFlight>>,
    pace: Mutex<Pace>,
    /// Set after a spool write failed, so the failure is logged once.
    failing: AtomicBool,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Shipper {
    pub fn new(spool: Spool) -> Self {
        Self {
            spool: Mutex::new(spool),
            in_flight: Mutex::new(None),
            pace: Mutex::new(Pace {
                tokens: RECORDS_PER_MINUTE as f64,
                at: Instant::now(),
            }),
            failing: AtomicBool::new(false),
        }
    }

    /// Moves the ship queue into the spool.
    pub fn flush(&self, queue: &ShipQueue) {
        let (pending, dropped) = queue.take();
        let result = lock(&self.spool).append(pending, dropped, now_ms());
        // Logged outside the spool's lock: the record lands in the queue.
        match result {
            Ok(()) => self.failing.store(false, Ordering::SeqCst),
            Err(error) => {
                if !self.failing.swap(true, Ordering::SeqCst) {
                    log::warn!("Could not write the log spool: {error}");
                }
            }
        }
    }

    /// Moves the queue into the spool every quarter second until `stop`.
    pub fn start_flusher(
        self: &Arc<Self>,
        queue: &'static ShipQueue,
        stop: Arc<AtomicBool>,
    ) -> io::Result<std::thread::JoinHandle<()>> {
        let shipper = Arc::clone(self);
        std::thread::Builder::new()
            .name("log-spool".into())
            .spawn(move || {
                while !stop.load(Ordering::SeqCst) {
                    shipper.flush(queue);
                    std::thread::sleep(FLUSH_EVERY);
                }
                shipper.flush(queue);
            })
    }

    /// The next `log-batch` to send, if nothing is waiting for its
    /// acknowledgement (or that wait timed out) and the pace allows.
    pub fn next_message(&self, now: Instant) -> Option<AgentMessage> {
        let mut in_flight = lock(&self.in_flight);
        if in_flight
            .as_ref()
            .is_some_and(|sent| now.saturating_duration_since(sent.sent) < ACK_TIMEOUT)
        {
            return None;
        }
        let mut pace = lock(&self.pace);
        let allowed = pace.available(now);
        if allowed == 0 {
            return None;
        }
        let (instance, records) = lock(&self.spool).next_batch(allowed)?;
        pace.spend(records.len());
        *in_flight = Some(InFlight {
            instance: instance.clone(),
            sent: now,
        });
        Some(AgentMessage::LogBatch { instance, records })
    }

    /// `log-ack` from the server.
    pub fn acked(&self, instance: &str, seq: u64) {
        let mut in_flight = lock(&self.in_flight);
        if in_flight
            .as_ref()
            .is_some_and(|sent| sent.instance == instance)
        {
            *in_flight = None;
        }
        if let Err(error) = lock(&self.spool).ack(instance, seq) {
            drop(in_flight);
            log::warn!("Could not update the log spool: {error}");
        }
    }

    /// A new connection: whatever was in flight is sent again.
    pub fn reconnected(&self) {
        *lock(&self.in_flight) = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pending(text: &str) -> Pending {
        Pending {
            at: 1_000,
            level: LogLevel::Info,
            source: LogSource::Agent,
            target: "bmuster_agent::test".into(),
            text: text.into(),
        }
    }

    fn spool_bytes(dir: &Path) -> u64 {
        fs::read_dir(dir)
            .unwrap()
            .flatten()
            .filter(|entry| segment_number(&entry.file_name().to_string_lossy()).is_some())
            .map(|entry| entry.metadata().unwrap().len())
            .sum()
    }

    #[test]
    fn spool_bounds_and_reports_drops() {
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join(SPOOL_DIR);
        let mut spool = Spool::open(&logs, "first").unwrap();
        // 4 KiB records, 2900 a minute (under the limit) for three minutes: about 35 MiB.
        let text = "x".repeat(4000);
        spool.limit.started_ms = 0;
        for minute in 0..3 {
            let now = minute * MINUTE_MS + 1;
            spool
                .append((0..2900).map(|_| pending(&text)).collect(), 0, now)
                .unwrap();
            assert!(spool_bytes(&logs) <= SPOOL_BYTES, "capped at 5 MiB");
        }
        let (_, oldest) = spool.next_batch(1).unwrap();
        assert!(oldest[0].seq > 1, "the oldest records were dropped");
        let notes: Vec<&Held> = spool
            .held
            .iter()
            .filter(|held| held.record.target == DROPPED_TARGET)
            .collect();
        assert!(!notes.is_empty());
        assert!(notes[0]
            .record
            .text
            .ends_with("log records were dropped: the spool reached its 5 MiB limit."));
        assert!(fs::read_dir(&logs)
            .unwrap()
            .flatten()
            .filter_map(|entry| segment_number(&entry.file_name().to_string_lossy()))
            .all(|n| n >= spool.segments.front().unwrap().n));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&logs), 0o700);
            let n = spool.segments.back().unwrap().n;
            assert_eq!(mode(&segment_path(&logs, n)), 0o600);
        }

        // A restart keeps everything still waiting, in order.
        let waiting: Vec<u64> = spool.held.iter().map(|held| held.record.seq).collect();
        drop(spool);
        let reopened = Spool::open(&logs, "second").unwrap();
        let kept: Vec<u64> = reopened.held.iter().map(|held| held.record.seq).collect();
        assert_eq!(kept, waiting);
        assert!(reopened.held.iter().all(|held| held.instance == "first"));

        // More than 3000 a minute: the excess is counted and reported once.
        let other = tempfile::tempdir().unwrap();
        let mut limited = Spool::open(other.path(), "busy").unwrap();
        limited.limit.started_ms = 0;
        limited
            .append((0..3100).map(|_| pending("busy")).collect(), 0, 10)
            .unwrap();
        assert_eq!(limited.held.len(), 3000);
        limited.append(Vec::new(), 7, MINUTE_MS + 10).unwrap();
        let texts: Vec<&str> = limited
            .held
            .iter()
            .skip(3000)
            .map(|held| held.record.text.as_str())
            .collect();
        assert_eq!(
            texts,
            [
                "7 log records were dropped: the agent's queue was full.",
                "100 log records were dropped: more than 3000 in a minute."
            ]
        );
    }

    #[test]
    fn ack_and_resend_in_order() {
        let dir = tempfile::tempdir().unwrap();
        let mut old = Spool::open(dir.path(), "old").unwrap();
        old.append((0..3).map(|n| pending(&format!("old {n}"))).collect(), 0, 1)
            .unwrap();
        drop(old);
        let mut spool = Spool::open(dir.path(), "new").unwrap();
        spool
            .append(
                (0..1200).map(|n| pending(&format!("new {n}"))).collect(),
                0,
                1,
            )
            .unwrap();

        // The earlier process's backlog goes first, never mixed with this one's.
        let (instance, records) = spool.next_batch(usize::MAX).unwrap();
        assert_eq!(instance, "old");
        assert_eq!(records.iter().map(|r| r.seq).collect::<Vec<_>>(), [1, 2, 3]);
        assert_eq!(spool.ack("old", 3).unwrap(), 3);

        let (instance, records) = spool.next_batch(usize::MAX).unwrap();
        assert_eq!(instance, "new");
        assert_eq!(records.len(), MAX_BATCH_RECORDS);
        assert_eq!(records[0].seq, 1);
        assert_eq!(records[499].seq, 500);
        // An acknowledgement for another process, or a smaller one, changes nothing more.
        assert_eq!(spool.ack("old", 500).unwrap(), 0);
        assert_eq!(spool.ack("new", 500).unwrap(), 500);
        let (_, records) = spool.next_batch(usize::MAX).unwrap();
        assert_eq!(records[0].seq, 501);

        // Not acknowledged before a restart: sent again from 501, in order.
        drop(spool);
        let spool = Spool::open(dir.path(), "third").unwrap();
        let (instance, records) = spool.next_batch(usize::MAX).unwrap();
        assert_eq!(instance, "new");
        assert_eq!(records.first().map(|r| r.seq), Some(501));
        assert!(records
            .windows(2)
            .all(|pair| pair[1].seq == pair[0].seq + 1));

        // Big records: a batch stays under 128 KiB of JSON.
        let big = tempfile::tempdir().unwrap();
        let mut spool = Spool::open(big.path(), "big").unwrap();
        spool
            .append((0..100).map(|_| pending(&"y".repeat(4000))).collect(), 0, 1)
            .unwrap();
        let (_, records) = spool.next_batch(usize::MAX).unwrap();
        let bytes: usize = records
            .iter()
            .map(|r| serde_json::to_vec(r).unwrap().len() + 1)
            .sum();
        assert!(records.len() < 100 && bytes <= MAX_BATCH_BYTES, "{bytes}");

        // The shipper waits for an acknowledgement, resends after a reconnect and paces itself.
        let shipper = Shipper::new(spool);
        let now = Instant::now();
        let Some(AgentMessage::LogBatch { records: first, .. }) = shipper.next_message(now) else {
            panic!("expected a batch");
        };
        assert!(shipper.next_message(now).is_none(), "one batch in flight");
        shipper.reconnected();
        let Some(AgentMessage::LogBatch { records: again, .. }) = shipper.next_message(now) else {
            panic!("expected the batch again");
        };
        assert_eq!(first[0].seq, again[0].seq);
        shipper.acked("big", again.last().unwrap().seq);
        assert!(
            shipper.next_message(now).is_some(),
            "the next batch follows the ack"
        );
        assert!(
            shipper.next_message(now + ACK_TIMEOUT).is_some(),
            "an unacknowledged batch is sent again after the timeout"
        );
    }
}
