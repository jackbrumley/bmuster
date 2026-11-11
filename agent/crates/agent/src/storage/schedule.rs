//! When a pass runs (SPEC-STORAGE 3.1), from the agent: 10 minutes after
//! start, again when a drive's scan is more than a day old, or when someone
//! asked (Rescan now). The pass is `bmuster-agent storage-scan`: a transient
//! systemd service on an installed Linux agent (outside the agent's sandbox,
//! whose private /tmp would hide the real one), a child process otherwise.
//! Stopping the agent stops the pass.

use super::pace::Speed;
use super::{clear_rescan, load_state, rescan_requested, State};
use crate::exec::placement::SessionMode;
use anyhow::{Context as _, Result};
use bmuster_protocol::storage::LastScan;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// The first pass waits this long after the agent starts.
pub const FIRST_DELAY: Duration = Duration::from_secs(10 * 60);
/// A drive's scan older than this is due again.
pub const RESCAN_AFTER_MS: i64 = 24 * 60 * 60 * 1000;
/// A pass that did not finish every drive is tried again after this.
pub const RETRY_AFTER: Duration = Duration::from_secs(60 * 60);
/// How often the scheduler looks for a due pass.
const CHECK_EVERY: Duration = Duration::from_secs(60);
/// How often it wakes: to notice Rescan now and clean-up requests, and to stop.
const TICK: Duration = Duration::from_millis(500);

/// What the scheduler knows when it looks.
pub struct Looking<'a> {
    pub now_ms: i64,
    pub since_start: Duration,
    /// Since the last pass this agent started, if it started one.
    pub since_last_pass: Option<Duration>,
    pub state: &'a State,
    pub targets: &'a [String],
    pub rescan: bool,
}

/// Whether a pass is due now, and how hard it works. The caller never asks
/// while a pass runs.
pub fn due(looking: &Looking) -> Option<Speed> {
    if looking.rescan {
        return Some(Speed::Asked);
    }
    if looking.since_start < FIRST_DELAY
        || looking
            .since_last_pass
            .is_some_and(|since| since < RETRY_AFTER)
    {
        return None;
    }
    let stale = looking
        .targets
        .iter()
        .any(|mount| match looking.state.last.get(mount) {
            Some(LastScan::Complete { finished_at_ms, .. }) => {
                looking.now_ms - finished_at_ms > RESCAN_AFTER_MS
            }
            Some(LastScan::None) | None => true,
        });
    stale.then_some(Speed::Background)
}

/// A helper process that is running: the scan pass or the clean-up.
pub(super) enum Pass {
    Child(Child),
    #[cfg(target_os = "linux")]
    Unit(Child, crate::exec::unit::TransientUnit),
}

impl Pass {
    fn child(&mut self) -> &mut Child {
        match self {
            Pass::Child(child) => child,
            #[cfg(target_os = "linux")]
            Pass::Unit(child, _) => child,
        }
    }

    pub(super) fn finished(&mut self) -> bool {
        !matches!(self.child().try_wait(), Ok(None))
    }

    pub(super) fn stop(self) {
        match self {
            Pass::Child(mut child) => {
                let _ = child.kill();
                let _ = child.wait();
            }
            #[cfg(target_os = "linux")]
            Pass::Unit(mut child, unit) => {
                unit.stop();
                let _ = child.wait();
            }
        }
    }
}

fn arguments(data_dir: &Path, speed: Speed) -> Vec<OsString> {
    let mut args: Vec<OsString> = vec![
        "storage-scan".into(),
        "--data-dir".into(),
        data_dir.as_os_str().to_os_string(),
    ];
    if speed == Speed::Asked {
        args.push("--asked".into());
    }
    args
}

/// Starts `bmuster-agent <args>`: the transient service
/// `bmuster-storage-<unit>.service` on an installed Linux agent (as root,
/// no network, lowest priority), a child process otherwise.
pub(super) fn launch(
    args: Vec<OsString>,
    unit: &str,
    what: &'static str,
    mode: SessionMode,
) -> Result<Pass> {
    #[cfg(target_os = "linux")]
    if let Some(manager) = mode.manager() {
        use crate::exec::placement::Kind;
        use crate::exec::spawn::{Launch, Program};
        use crate::exec::unit::TransientUnit;
        let unit = TransientUnit::new(manager, Kind::Storage, unit)?;
        let program: PathBuf = crate::exec::unit::program(manager)?;
        let launch = Launch {
            program: Program {
                arg0: program.clone().into_os_string(),
                path: program,
                args,
            },
            env: vec![("PATH".into(), crate::exec::spawn::UNIX_PATH.into())],
            cwd: PathBuf::from("/"),
        };
        let child = unit
            .command(None, &launch)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .with_context(|| format!("could not run systemd-run for the {what}"))?;
        log::info!("Storage: the {what} started as {}.", unit.name());
        return Ok(Pass::Unit(child, unit));
    }
    let _ = (mode, unit);
    let program = std::env::current_exe().context("could not find this program's path")?;
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("could not start the {what}"))?;
    crate::diagnostics::ship_helper_stderr(what, child.stderr.take());
    log::info!("Storage: the {what} started (process {}).", child.id());
    Ok(Pass::Child(child))
}

/// Starts the scheduler's thread; it ends, stopping any pass, with `stop`.
/// It also starts clean-ups when asked ([`super::cleanup::launch`]).
pub fn start(data_dir: PathBuf, mode: SessionMode, stop: Arc<AtomicBool>) {
    let started = std::thread::Builder::new()
        .name("storage-scheduler".into())
        .spawn(move || run(&data_dir, mode, &stop));
    if let Err(e) = started {
        log::error!("Storage: could not start the scheduler: {e}");
    }
}

/// Whether to look for a due pass now: at the regular minute, or at once
/// when someone asked for one and no pass runs (S25).
pub fn look_now(next_look: Instant, now: Instant, rescan: bool, running: bool) -> bool {
    !running && (rescan || now >= next_look)
}

fn run(data_dir: &Path, mode: SessionMode, stop: &AtomicBool) {
    let agent_started = Instant::now();
    let mut last_pass: Option<Instant> = None;
    let mut running: Option<Pass> = None;
    let mut cleaner = super::cleanup::launch::Launcher::default();
    let mut next_look = Instant::now();
    while !stop.load(Ordering::SeqCst) {
        if running.as_mut().is_some_and(Pass::finished) {
            running = None;
        }
        let rescan = rescan_requested(data_dir);
        if look_now(next_look, Instant::now(), rescan, running.is_some()) {
            next_look = Instant::now() + CHECK_EVERY;
            let state = load_state(data_dir);
            let targets = crate::files::roots::scan_targets();
            let looking = Looking {
                now_ms: super::scan::now_ms(),
                since_start: agent_started.elapsed(),
                since_last_pass: last_pass.map(|at| at.elapsed()),
                state: &state,
                targets: &targets,
                rescan,
            };
            if let Some(speed) = due(&looking) {
                clear_rescan(data_dir);
                last_pass = Some(Instant::now());
                match launch(arguments(data_dir, speed), "scan", "storage scan", mode) {
                    Ok(pass) => running = Some(pass),
                    Err(e) => log::warn!("Storage: {e:#}"),
                }
            }
        }
        cleaner.tick(data_dir, mode);
        std::thread::sleep(TICK);
    }
    if let Some(pass) = running {
        pass.stop();
    }
    cleaner.stop();
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOUR: Duration = Duration::from_secs(3600);

    fn complete(finished_at_ms: i64) -> LastScan {
        LastScan::Complete {
            started_at_ms: 0,
            finished_at_ms,
            scanned_bytes: 0,
            used_bytes: 0,
            files: 0,
            folders: 0,
            denied: 0,
        }
    }

    fn looking<'a>(state: &'a State, targets: &'a [String]) -> Looking<'a> {
        Looking {
            now_ms: 100 * RESCAN_AFTER_MS,
            since_start: HOUR,
            since_last_pass: None,
            state,
            targets,
            rescan: false,
        }
    }

    #[test]
    fn s6_the_first_pass_waits_ten_minutes_after_start() {
        let state = State::default();
        let targets = vec!["/".to_string()];
        let mut early = looking(&state, &targets);
        early.since_start = Duration::from_secs(5 * 60);
        assert_eq!(due(&early), None);
        assert_eq!(due(&looking(&state, &targets)), Some(Speed::Background));
    }

    #[test]
    fn s6_a_scan_older_than_a_day_is_due_again() {
        let targets = vec!["/".to_string(), "/home".to_string()];
        let now = 100 * RESCAN_AFTER_MS;
        let mut state = State::default();
        state
            .last
            .insert("/".into(), complete(now - HOUR.as_millis() as i64));
        state
            .last
            .insert("/home".into(), complete(now - 2 * HOUR.as_millis() as i64));
        assert_eq!(due(&looking(&state, &targets)), None);
        state
            .last
            .insert("/home".into(), complete(now - RESCAN_AFTER_MS - 1));
        assert_eq!(due(&looking(&state, &targets)), Some(Speed::Background));
        // A pass that just ran and could not finish waits before trying again.
        let mut retried = looking(&state, &targets);
        retried.since_last_pass = Some(Duration::from_secs(60));
        assert_eq!(due(&retried), None);
    }

    #[test]
    fn s6_rescan_now_starts_a_faster_pass_at_once() {
        let state = State::default();
        let targets = vec!["/".to_string()];
        let mut asked = looking(&state, &targets);
        asked.since_start = Duration::from_secs(1);
        asked.since_last_pass = Some(Duration::from_secs(1));
        asked.rescan = true;
        assert_eq!(due(&asked), Some(Speed::Asked));
    }

    #[test]
    fn s25_a_rescan_request_is_looked_at_within_a_tick() {
        let now = Instant::now();
        let later = now + CHECK_EVERY;
        assert!(look_now(later, now, true, false), "asked: at once");
        assert!(
            !look_now(later, now, false, false),
            "not asked: at the minute"
        );
        assert!(look_now(now, now, false, false));
        assert!(!look_now(now, now, true, true), "never while a pass runs");
        assert!(TICK <= Duration::from_secs(1));
    }

    #[test]
    fn the_pass_is_the_storage_scan_command() {
        let args = arguments(Path::new("/var/lib/bmuster"), Speed::Asked);
        assert_eq!(
            args,
            ["storage-scan", "--data-dir", "/var/lib/bmuster", "--asked"].map(OsString::from)
        );
    }
}
