//! Self-checks (SPEC-DIAGNOSTICS 1): a fixed list of checks, each trying one
//! capability for real in a harmless way, reporting `pass`, `fail` with the
//! reason, or `not-applicable`.
//!
//! - **When:** a minute after start (so every new version reports itself),
//!   every six hours, after a session fails to start (at most once in five
//!   minutes) and when an admin asks (`run-checks`). One thread runs them,
//!   one at a time, so two runs never overlap; asks that arrive during a run
//!   are answered by it.
//! - **Bounds:** each check has [`CHECK_DEADLINE`], the whole run
//!   [`RUN_DEADLINE`]. Checks never prompt the person at the machine, never
//!   show anything and leave no unit, device or file behind.
//! - **Results** go into every check-in (the latest set), to the live socket
//!   after each run, and into the log as one record per failed check.
//!
//! Nothing from the server changes what a check does: `run-checks` carries
//! no arguments, and every check is a fixed code path here.

#[cfg(target_os = "linux")]
mod linux;
#[cfg(windows)]
pub mod windows;

use crate::exec::placement::SessionMode;
use crate::logging::{now_ms, ShipQueue, SHIP};
use bmuster_protocol::checks::{
    CheckResult, CheckStatus, ChecksReport, MAX_CHECKS, MAX_CHECK_DETAIL_BYTES,
};
use bmuster_protocol::logs::{cut_text, LogLevel};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// Each check's time limit.
pub const CHECK_DEADLINE: Duration = Duration::from_secs(10);
/// The whole run's time limit.
pub const RUN_DEADLINE: Duration = Duration::from_secs(60);
/// The first run comes this long after start.
pub const FIRST_RUN: Duration = Duration::from_secs(60);
/// Then every this long.
pub const EVERY: Duration = Duration::from_secs(6 * 60 * 60);
/// After a failed session, at most one run in this long.
pub const AFTER_FAILURE_GAP: Duration = Duration::from_secs(5 * 60);
/// The target of the log record for a failed check.
const CHECKS_TARGET: &str = "checks";

/// What one check found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Pass(String),
    Fail(String),
    NotApplicable(String),
}

/// What a check may know about the agent: nothing from the server.
#[derive(Debug, Clone)]
pub struct Context {
    pub data_dir: PathBuf,
    /// Where sessions run (the Linux unit checks follow it).
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub mode: SessionMode,
}

/// One check: a fixed id, a title and a fixed code path.
pub struct Check {
    pub id: &'static str,
    pub title: &'static str,
    pub run: fn(&Context) -> Outcome,
}

/// Takes the sleep inhibitor and releases it at once (SPEC-STAY-AWAKE 5):
/// nothing else changes, and the keeper's own lock (if it holds one) is
/// untouched, since logind and Windows each allow several.
#[cfg(any(target_os = "linux", windows))]
fn stay_awake_check() -> Check {
    Check {
        id: "stay-awake",
        title: "Hold off automatic sleep (Stay awake on mains power)",
        run: stay_awake,
    }
}

#[cfg(any(target_os = "linux", windows))]
fn stay_awake(_: &Context) -> Outcome {
    stay_awake_with(&mut crate::power::platform_inhibitor())
}

#[cfg_attr(not(any(target_os = "linux", windows)), allow(dead_code))]
fn stay_awake_with<I: crate::power::Inhibit>(inhibit: &mut I) -> Outcome {
    match inhibit.take() {
        Ok(lock) => {
            drop(lock);
            #[cfg(windows)]
            let what = "Set and cleared ES_SYSTEM_REQUIRED on a thread of its own.";
            #[cfg(not(windows))]
            let what = "Took and released a logind sleep:idle inhibitor lock.";
            Outcome::Pass(what.into())
        }
        Err(reason) => Outcome::Fail(reason),
    }
}

/// This operating system's checks, in the order the console lists them.
pub fn platform_checks() -> Vec<Check> {
    #[cfg(target_os = "linux")]
    {
        linux::checks()
    }
    #[cfg(windows)]
    {
        windows::checks()
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    {
        Vec::new()
    }
}

fn result(check: &Check, outcome: Outcome, duration: Duration, checked_at: u64) -> CheckResult {
    let (status, detail) = match outcome {
        Outcome::Pass(detail) => (CheckStatus::Pass, detail),
        Outcome::Fail(detail) => (CheckStatus::Fail, detail),
        Outcome::NotApplicable(detail) => (CheckStatus::NotApplicable, detail),
    };
    CheckResult {
        id: check.id.to_string(),
        title: check.title.to_string(),
        status,
        detail: cut_text(
            &crate::diagnostics::redact_lines(detail.trim()),
            MAX_CHECK_DETAIL_BYTES,
        ),
        duration_ms: u64::try_from(duration.as_millis()).unwrap_or(u64::MAX),
        checked_at,
    }
}

/// Runs `checks` one after another, each on its own thread with `deadline`,
/// the whole run within `run_deadline`. A check that overruns is reported
/// as failed (its own code still cleans up after itself when it finishes).
pub fn run_all(
    checks: &[Check],
    context: &Context,
    deadline: Duration,
    run_deadline: Duration,
) -> Vec<CheckResult> {
    let run_ends = Instant::now() + run_deadline;
    let mut results = Vec::new();
    for check in checks.iter().take(MAX_CHECKS) {
        let started = Instant::now();
        let checked_at = now_ms();
        let left = run_ends.saturating_duration_since(started);
        if left.is_zero() {
            results.push(result(
                check,
                Outcome::Fail(format!(
                    "Not run: the {} s for the whole run ran out.",
                    run_deadline.as_secs()
                )),
                Duration::ZERO,
                checked_at,
            ));
            continue;
        }
        let (send, outcome) = mpsc::channel();
        let run = check.run;
        let context = context.clone();
        let spawned = std::thread::Builder::new()
            .name(format!("check {}", check.id))
            .spawn(move || {
                let _ = send.send(run(&context));
            });
        let outcome = match spawned {
            Err(error) => Outcome::Fail(format!("Could not start the check: {error}")),
            Ok(_) => match outcome.recv_timeout(deadline.min(left)) {
                Ok(outcome) => outcome,
                Err(RecvTimeoutError::Timeout) => Outcome::Fail(format!(
                    "Did not finish within {} s.",
                    deadline.min(left).as_secs_f32()
                )),
                Err(RecvTimeoutError::Disconnected) => {
                    Outcome::Fail("The check stopped unexpectedly (it panicked).".into())
                }
            },
        };
        results.push(result(check, outcome, started.elapsed(), checked_at));
    }
    results
}

/// Why a run starts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trigger {
    /// A minute after start, then every six hours.
    Scheduled,
    /// A session failed to start.
    SessionFailed,
    /// An admin clicked Run checks (`run-checks`).
    Asked,
}

/// When the next run is due. Pure, so the rules can be tested without time.
#[derive(Debug)]
pub struct Schedule {
    next_due: Instant,
    last_failure_run: Option<Instant>,
    pending: Option<Trigger>,
}

/// What the runner does next.
#[derive(Debug, PartialEq, Eq)]
pub enum Next {
    Run(Trigger),
    Wait(Duration),
}

impl Schedule {
    pub fn new(started: Instant) -> Self {
        Self {
            next_due: started + FIRST_RUN,
            last_failure_run: None,
            pending: None,
        }
    }

    /// Something asked for a run. A failed session within
    /// [`AFTER_FAILURE_GAP`] of the last one that ran the checks is ignored.
    pub fn request(&mut self, trigger: Trigger, now: Instant) {
        if trigger == Trigger::SessionFailed
            && self
                .last_failure_run
                .is_some_and(|at| now.saturating_duration_since(at) < AFTER_FAILURE_GAP)
        {
            return;
        }
        // An admin's ask wins over a failure's, so the socket gets results.
        if self.pending != Some(Trigger::Asked) {
            self.pending = Some(trigger);
        }
    }

    pub fn next(&self, now: Instant) -> Next {
        if let Some(trigger) = self.pending {
            return Next::Run(trigger);
        }
        if now >= self.next_due {
            return Next::Run(Trigger::Scheduled);
        }
        Next::Wait(self.next_due - now)
    }

    /// A run for `trigger` finished at `now`: the next scheduled one is six
    /// hours on, whatever started this one.
    pub fn ran(&mut self, trigger: Trigger, now: Instant) {
        self.pending = None;
        self.next_due = now + EVERY;
        if trigger == Trigger::SessionFailed {
            self.last_failure_run = Some(now);
        }
    }
}

/// The latest results, and whether the live socket still has to send them.
pub struct Latest {
    report: Mutex<ChecksReport>,
    unsent: AtomicBool,
}

impl Latest {
    pub const fn new() -> Self {
        Self {
            report: Mutex::new(ChecksReport::Pending),
            unsent: AtomicBool::new(false),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, ChecksReport> {
        self.report
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Replaces the set and logs each failed check once.
    pub fn publish(&self, queue: &ShipQueue, results: Vec<CheckResult>) {
        for failed in results.iter().filter(|r| r.status == CheckStatus::Fail) {
            crate::logging::note(
                queue,
                LogLevel::Warn,
                CHECKS_TARGET,
                &format!("{} ({}): {}", failed.title, failed.id, failed.detail),
            );
        }
        *self.lock() = ChecksReport::Results { results };
        self.unsent.store(true, Ordering::SeqCst);
    }

    /// The check-in's `checks`.
    pub fn report(&self) -> ChecksReport {
        self.lock().clone()
    }

    /// The results the live socket has not sent yet, once.
    pub fn take_unsent(&self) -> Option<Vec<CheckResult>> {
        if !self.unsent.swap(false, Ordering::SeqCst) {
            return None;
        }
        match &*self.lock() {
            ChecksReport::Results { results } => Some(results.clone()),
            ChecksReport::Pending => None,
        }
    }
}

/// The running agent's results.
pub static LATEST: Latest = Latest::new();
static REQUESTS: OnceLock<Mutex<Sender<Trigger>>> = OnceLock::new();

/// Asks the running agent for a run (a no-op before [`start`] and in other
/// commands).
pub fn request(trigger: Trigger) {
    if let Some(sender) = REQUESTS.get() {
        let _ = sender
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .send(trigger);
    }
}

/// The runner's times; tests shorten them.
#[derive(Debug, Clone, Copy)]
pub struct Timings {
    pub check: Duration,
    pub run: Duration,
}

/// Runs the schedule on this thread until `requests` closes: one run at a
/// time, `publish` after each.
pub fn run_schedule(
    checks: &[Check],
    context: &Context,
    timings: Timings,
    mut schedule: Schedule,
    requests: &Receiver<Trigger>,
    publish: &mut dyn FnMut(Trigger, Vec<CheckResult>),
) {
    loop {
        match schedule.next(Instant::now()) {
            Next::Run(trigger) => {
                log::info!("Running the self-checks ({trigger:?}).");
                let results = run_all(checks, context, timings.check, timings.run);
                // Asks that came in during the run are answered by it.
                while requests.try_recv().is_ok() {}
                schedule.ran(trigger, Instant::now());
                publish(trigger, results);
            }
            Next::Wait(wait) => match requests.recv_timeout(wait) {
                Ok(trigger) => schedule.request(trigger, Instant::now()),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return,
            },
        }
    }
}

/// Starts the worker's checks thread.
pub fn start(context: Context) {
    let (sender, requests) = mpsc::channel();
    if REQUESTS.set(Mutex::new(sender)).is_err() {
        return;
    }
    let started = std::thread::Builder::new()
        .name("checks".into())
        .spawn(move || {
            let checks = platform_checks();
            let any_failed = Arc::new(AtomicBool::new(false));
            run_schedule(
                &checks,
                &context,
                Timings {
                    check: CHECK_DEADLINE,
                    run: RUN_DEADLINE,
                },
                Schedule::new(Instant::now()),
                &requests,
                &mut |_trigger, results| {
                    let failed = results.iter().any(|r| r.status == CheckStatus::Fail);
                    LATEST.publish(&SHIP, results);
                    // The journal and audit denials explain a failed check
                    // the way they explain a failed session.
                    if failed && !any_failed.swap(true, Ordering::SeqCst) {
                        crate::diagnostics::session_failed("self-check");
                    }
                    if !failed {
                        any_failed.store(false, Ordering::SeqCst);
                    }
                },
            );
        });
    if let Err(error) = started {
        log::error!("Could not start the self-checks: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    fn context() -> Context {
        Context {
            data_dir: std::env::temp_dir(),
            mode: SessionMode::InProcess,
        }
    }

    fn passes(_: &Context) -> Outcome {
        Outcome::Pass("it works".into())
    }
    fn fails(_: &Context) -> Outcome {
        Outcome::Fail(format!("broken {}", "x".repeat(5000)))
    }
    fn not_here(_: &Context) -> Outcome {
        Outcome::NotApplicable("not on this machine".into())
    }
    fn hangs(_: &Context) -> Outcome {
        std::thread::sleep(Duration::from_millis(1500));
        Outcome::Pass("too late".into())
    }
    fn panics(_: &Context) -> Outcome {
        panic!("a check that panics")
    }

    fn check(id: &'static str, run: fn(&Context) -> Outcome) -> Check {
        Check {
            id,
            title: "A check",
            run,
        }
    }

    /// SPEC-DIAGNOSTICS D1: every status, the deadline, the run's deadline,
    /// the detail limit, and the real list with nothing left behind.
    #[test]
    fn linux_checks_report_each_status() {
        let checks = [
            check("passes", passes),
            check("fails", fails),
            check("not-here", not_here),
            check("hangs", hangs),
            check("panics", panics),
        ];
        let results = run_all(
            &checks,
            &context(),
            Duration::from_millis(200),
            Duration::from_secs(5),
        );
        let statuses: Vec<(&str, CheckStatus)> =
            results.iter().map(|r| (r.id.as_str(), r.status)).collect();
        assert_eq!(
            statuses,
            [
                ("passes", CheckStatus::Pass),
                ("fails", CheckStatus::Fail),
                ("not-here", CheckStatus::NotApplicable),
                ("hangs", CheckStatus::Fail),
                ("panics", CheckStatus::Fail),
            ]
        );
        assert!(results[1].detail.starts_with("broken"));
        assert!(results[1].detail.len() <= MAX_CHECK_DETAIL_BYTES);
        assert!(results[3].detail.contains("Did not finish within 0.2 s"));
        assert!(results[3].duration_ms < 1000);

        // The run's own deadline: what is left is reported, not run.
        let slow = [check("hangs", hangs), check("passes", passes)];
        let results = run_all(
            &slow,
            &context(),
            Duration::from_secs(5),
            Duration::from_millis(300),
        );
        assert_eq!(results[1].status, CheckStatus::Fail);
        assert!(results[1].detail.starts_with("Not run"), "{:?}", results[1]);

        #[cfg(target_os = "linux")]
        linux::tests::the_list_is_fixed_and_leaves_nothing_behind();
    }

    /// SPEC-DIAGNOSTICS D2.
    #[test]
    fn schedule_and_triggers() {
        let start = Instant::now();
        let mut schedule = Schedule::new(start);
        assert_eq!(schedule.next(start), Next::Wait(FIRST_RUN));
        assert_eq!(
            schedule.next(start + FIRST_RUN),
            Next::Run(Trigger::Scheduled),
            "a minute after start"
        );
        let first = start + FIRST_RUN;
        schedule.ran(Trigger::Scheduled, first);
        assert_eq!(
            schedule.next(first),
            Next::Wait(EVERY),
            "then every six hours"
        );

        schedule.request(Trigger::SessionFailed, first);
        assert_eq!(schedule.next(first), Next::Run(Trigger::SessionFailed));
        schedule.ran(Trigger::SessionFailed, first);
        schedule.request(Trigger::SessionFailed, first + Duration::from_secs(60));
        assert_eq!(
            schedule.next(first + Duration::from_secs(60)),
            Next::Wait(EVERY - Duration::from_secs(60)),
            "a second failure within five minutes waits"
        );
        schedule.request(Trigger::SessionFailed, first + AFTER_FAILURE_GAP);
        assert_eq!(
            schedule.next(first + AFTER_FAILURE_GAP),
            Next::Run(Trigger::SessionFailed)
        );
        schedule.request(Trigger::Asked, first + AFTER_FAILURE_GAP);
        schedule.request(Trigger::SessionFailed, first + AFTER_FAILURE_GAP);
        assert_eq!(
            schedule.next(first + AFTER_FAILURE_GAP),
            Next::Run(Trigger::Asked),
            "an admin's ask is kept"
        );

        // Never two runs at once, and asks during a run are answered by it.
        static RUNNING: AtomicUsize = AtomicUsize::new(0);
        static MOST: AtomicUsize = AtomicUsize::new(0);
        static RUNS: AtomicUsize = AtomicUsize::new(0);
        fn counted(_: &Context) -> Outcome {
            let now = RUNNING.fetch_add(1, Ordering::SeqCst) + 1;
            MOST.fetch_max(now, Ordering::SeqCst);
            RUNS.fetch_add(1, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(100));
            RUNNING.fetch_sub(1, Ordering::SeqCst);
            Outcome::Pass(String::new())
        }
        let (sender, requests) = mpsc::channel();
        let runner = std::thread::spawn(move || {
            let mut published = Vec::new();
            run_schedule(
                &[check("counted", counted)],
                &context(),
                Timings {
                    check: Duration::from_secs(2),
                    run: Duration::from_secs(5),
                },
                Schedule::new(Instant::now()),
                &requests,
                &mut |trigger, results| published.push((trigger, results.len())),
            );
            published
        });
        sender.send(Trigger::Asked).unwrap();
        std::thread::sleep(Duration::from_millis(30));
        for _ in 0..5 {
            sender.send(Trigger::Asked).unwrap();
        }
        std::thread::sleep(Duration::from_millis(400));
        drop(sender);
        let published = runner.join().unwrap();
        assert_eq!(MOST.load(Ordering::SeqCst), 1, "never concurrently");
        assert_eq!(
            published,
            [(Trigger::Asked, 1)],
            "one run answered all six asks"
        );
        assert_eq!(RUNS.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn results_reach_the_check_in_the_socket_and_the_log() {
        let latest = Latest::new();
        let queue: &'static ShipQueue = Box::leak(Box::new(ShipQueue::new()));
        queue.enable();
        assert_eq!(latest.report(), ChecksReport::Pending);
        assert_eq!(latest.take_unsent(), None);
        let results = run_all(
            &[check("passes", passes), check("fails", fails)],
            &context(),
            Duration::from_secs(1),
            Duration::from_secs(5),
        );
        latest.publish(queue, results.clone());
        assert_eq!(
            latest.report(),
            ChecksReport::Results {
                results: results.clone()
            }
        );
        assert_eq!(latest.take_unsent(), Some(results));
        assert_eq!(latest.take_unsent(), None, "sent once");
        let (records, _) = queue.take();
        let ours: Vec<_> = records
            .iter()
            .filter(|r| r.target == CHECKS_TARGET)
            .collect();
        assert_eq!(ours.len(), 1, "one record per failed check");
        assert_eq!(ours[0].level, LogLevel::Warn);
        assert!(ours[0].text.starts_with("A check (fails): broken"));
    }

    /// SPEC-STAY-AWAKE P8: the check takes the inhibitor once and releases
    /// it, and a refusal fails with the reason.
    #[test]
    fn stay_awake_check() {
        use crate::power::tests::FakeInhibitor;
        let fake = FakeInhibitor::default();
        let outcome = stay_awake_with(&mut fake.clone());
        assert!(matches!(outcome, Outcome::Pass(_)), "{outcome:?}");
        assert_eq!(fake.state.borrow().taken, 1);
        assert_eq!(fake.state.borrow().live, 0, "released");

        fake.state.borrow_mut().fail_with = Some("Access denied".into());
        assert_eq!(
            stay_awake_with(&mut fake.clone()),
            Outcome::Fail("Access denied".into())
        );
        #[cfg(any(target_os = "linux", windows))]
        assert_eq!(super::stay_awake_check().id, "stay-awake");
    }

    /// SPEC-DIAGNOSTICS D3.
    #[test]
    fn checks_capture_and_inject_nothing() {
        #[cfg(target_os = "linux")]
        linux::tests::the_uinput_device_has_no_capabilities_and_kms_sends_no_pixels();
    }
}
