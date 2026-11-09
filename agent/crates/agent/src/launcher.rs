//! `bmuster-agent launch`: the service's own process (SPEC-AGENT-UPDATES).
//!
//! It runs the worker, `versions/current/bmuster-agent run --launched`, and
//! starts it again when it stops. When the worker exits with
//! [`EXIT_UPDATE`], a checked build waits in `versions/incoming`: the launcher
//! checks it again with its own trusted keys, keeps the running version as
//! `previous`, switches, and gives the new worker [`HEALTH_WINDOW`] to check
//! in. If it does not, the launcher switches back and records "rolled back"
//! with the reason, which the old worker reports in its next check-in.
//!
//! On Linux the service runs `versions/current/bmuster-agent launch`, so the
//! launcher is the current version's own binary and updates with it (from
//! its next start). A launcher that cannot start is rolled back by the
//! rescue copy (`rescue.rs`). On Windows the service runs the copy in
//! Program Files, because Windows cannot rename the folder of a running
//! program; that copy is refreshed after a day of health.

use crate::updates::{self, check_build, now_ms, Layout, Slot, Switch};
use anyhow::{bail, Context as _, Result};
use bmuster_protocol::UpdateEvent;
use ed25519_dalek::VerifyingKey;
use std::collections::VecDeque;
use std::ffi::OsString;
use std::fs;
use std::io::{BufRead as _, BufReader, Write as _};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// The worker exits with this when a checked build waits in `incoming`.
pub const EXIT_UPDATE: u8 = 5;
/// How long a new version has to check in before it is rolled back.
pub const HEALTH_WINDOW: Duration = Duration::from_secs(120);
/// Wait before starting a worker that crashed (like systemd's RestartSec).
const RESTART_DELAY: Duration = Duration::from_secs(10);
const POLL: Duration = Duration::from_millis(250);
/// How many of the worker's last stderr lines an exit record carries.
pub const TAIL_LINES: usize = 20;
/// The target of exit records (SPEC-DIAGNOSTICS 2).
pub const EXIT_TARGET: &str = "launcher";

/// Exit codes the worker uses (main.rs).
const EXIT_STOPPED: i32 = 0;
const EXIT_REVOKED: i32 = crate::EXIT_REVOKED as i32;
const EXIT_RESTART: i32 = crate::EXIT_RESTART as i32;

/// How the launcher's run ended.
#[derive(Debug, PartialEq, Eq)]
pub enum Ended {
    /// The worker stopped cleanly, or the service manager asked to stop.
    Stopped,
    /// The server removed this machine; the service must not restart it.
    Revoked,
}

pub struct Launcher {
    pub data_dir: PathBuf,
    /// Arguments after `run --launched --data-dir <dir>`.
    pub worker_args: Vec<OsString>,
    /// The program that seeds `current` when there is none: this launcher.
    pub own_binary: PathBuf,
    pub own_version: String,
    pub keys: Vec<VerifyingKey>,
    pub health_window: Duration,
    pub restart_delay: Duration,
}

/// How a trial run went.
enum Trial {
    Healthy,
    Failed(String),
    Stopped,
}

impl Launcher {
    /// The installed launcher, as `launch` starts it.
    pub fn new(data_dir: PathBuf, worker_args: Vec<OsString>) -> Result<Self> {
        Ok(Self {
            data_dir,
            worker_args,
            own_binary: std::env::current_exe().context("could not find this program's path")?,
            own_version: updates::VERSION.to_string(),
            keys: updates::trusted_keys(),
            health_window: HEALTH_WINDOW,
            restart_delay: RESTART_DELAY,
        })
    }

    fn layout(&self) -> Layout {
        Layout::new(&self.data_dir)
    }

    /// Runs workers until one stops for good or `stop` is set.
    pub fn run(&self, stop: &AtomicBool) -> Result<Ended> {
        self.recover()?;
        log::info!(
            "BMuster launcher {} started; running version {}.",
            self.own_version,
            self.layout().release(Slot::Current)?.version
        );
        loop {
            if stop.load(Ordering::SeqCst) {
                return Ok(Ended::Stopped);
            }
            let marker = self.layout().checked_in_marker();
            if marker.exists() {
                fs::remove_file(&marker)
                    .with_context(|| format!("could not remove {}", marker.display()))?;
            }
            let switch = self.layout().switch()?;
            let (mut child, tail) = self.spawn()?;
            let started = Instant::now();
            if let Some(switch) = switch {
                match self.trial(&mut child, &switch, stop)? {
                    Trial::Healthy => self.commit(&switch)?,
                    Trial::Failed(reason) => {
                        stop_child(&mut child);
                        if let Ok(Some(status)) = child.try_wait() {
                            self.record_exit(&status, started.elapsed(), &tail);
                        }
                        self.roll_back(&switch, &reason)?;
                        continue;
                    }
                    Trial::Stopped => {
                        // The switch stays on trial; the next start tries again.
                        stop_child(&mut child);
                        return Ok(Ended::Stopped);
                    }
                }
            }
            let Some(status) = wait(&mut child, stop)? else {
                stop_child(&mut child);
                return Ok(Ended::Stopped);
            };
            self.record_exit(&status, started.elapsed(), &tail);
            match status.code() {
                Some(EXIT_STOPPED) => return Ok(Ended::Stopped),
                Some(EXIT_REVOKED) => return Ok(Ended::Revoked),
                Some(EXIT_RESTART) => log::info!("Starting the agent again."),
                Some(code) if code == i32::from(EXIT_UPDATE) => self.switch_to_incoming()?,
                _ => {
                    log::warn!(
                        "The agent stopped unexpectedly ({status}); starting it again in {} s.",
                        self.restart_delay.as_secs()
                    );
                    if sleep_unless_stopped(self.restart_delay, stop) {
                        return Ok(Ended::Stopped);
                    }
                }
            }
        }
    }

    /// Makes sure `current` holds a worker: finishes or undoes a switch that a
    /// crash or power cut interrupted, or seeds it with this launcher.
    fn recover(&self) -> Result<()> {
        let layout = self.layout();
        fs::create_dir_all(layout.root())
            .with_context(|| format!("could not create {}", layout.root().display()))?;
        if layout.binary(Slot::Current).exists() {
            return Ok(());
        }
        if layout.switch()?.is_some() && layout.binary(Slot::Incoming).exists() {
            log::info!("Finishing a switch that was interrupted.");
            return layout.rename(Slot::Incoming, Slot::Current);
        }
        if layout.binary(Slot::Previous).exists() {
            log::warn!("The current version is missing; going back to the previous one.");
            layout.end_switch()?;
            return layout.rename(Slot::Previous, Slot::Current);
        }
        let bytes = fs::read(&self.own_binary)
            .with_context(|| format!("could not read {}", self.own_binary.display()))?;
        updates::seed_current(&layout, &bytes, &self.own_version)?;
        log::info!(
            "Set up {} with this program (version {}).",
            layout.dir(Slot::Current).display(),
            self.own_version
        );
        Ok(())
    }

    /// Leaves a record of the worker's exit in the log spool, which the next
    /// worker ships (SPEC-DIAGNOSTICS 2): exit code or signal, uptime and
    /// its last stderr lines. A clean stop is `info`, anything else `error`.
    fn record_exit(&self, status: &ExitStatus, uptime: Duration, tail: &Tail) {
        let (level, what) = describe_exit(status);
        let lines = tail.lines();
        let text = if lines.is_empty() {
            format!(
                "The agent {what} after {}; it wrote nothing to stderr.",
                describe_uptime(uptime)
            )
        } else {
            format!(
                "The agent {what} after {}; its last {} lines on stderr:\n{}",
                describe_uptime(uptime),
                lines.len(),
                lines.join("\n")
            )
        };
        let record = crate::logging::Pending {
            at: crate::logging::now_ms(),
            level,
            source: bmuster_protocol::logs::LogSource::Agent,
            target: EXIT_TARGET.into(),
            text,
        };
        let spool = self.data_dir.join(crate::log_spool::SPOOL_DIR);
        if let Err(error) = crate::log_spool::leave_record(&spool, &record) {
            log::warn!("Could not record the agent's exit: {error}");
        }
    }

    fn spawn(&self) -> Result<(Child, Tail)> {
        let program = self.layout().binary(Slot::Current);
        let mut command = Command::new(&program);
        command
            .arg("run")
            .arg("--launched")
            .arg("--data-dir")
            .arg(&self.data_dir)
            .args(&self.worker_args)
            // The machine report names the launcher's version (SPEC-AGENT-LOGS 3).
            .env(
                crate::display_report::LAUNCHER_VERSION_ENV,
                &self.own_version,
            )
            .stdin(Stdio::null())
            // Read for the exit record, and passed on to the launcher's own.
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt as _;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = command
            .spawn()
            .with_context(|| format!("could not start {}", program.display()))?;
        let tail = Tail::follow(child.stderr.take());
        Ok((child, tail))
    }

    /// Waits for the new worker's first check-in, its exit, or the deadline.
    fn trial(&self, child: &mut Child, switch: &Switch, stop: &AtomicBool) -> Result<Trial> {
        log::info!(
            "Trying version {}; it has {} s to check in.",
            switch.to,
            self.health_window.as_secs()
        );
        let marker = self.layout().checked_in_marker();
        let deadline = Instant::now() + self.health_window;
        loop {
            if stop.load(Ordering::SeqCst) {
                return Ok(Trial::Stopped);
            }
            if fs::read_to_string(&marker).is_ok_and(|version| version == switch.to) {
                return Ok(Trial::Healthy);
            }
            if let Some(status) = child.try_wait().context("could not watch the agent")? {
                return Ok(Trial::Failed(format!(
                    "version {} stopped before it checked in ({status})",
                    switch.to
                )));
            }
            if Instant::now() >= deadline {
                return Ok(Trial::Failed(format!(
                    "version {} did not check in within {} s",
                    switch.to,
                    self.health_window.as_secs()
                )));
            }
            std::thread::sleep(POLL);
        }
    }

    fn commit(&self, switch: &Switch) -> Result<()> {
        self.layout().end_switch()?;
        updates::record_event(
            &self.data_dir,
            UpdateEvent::Updated {
                from: switch.from.clone(),
                to: switch.to.clone(),
                at_ms: now_ms(),
            },
        )?;
        log::info!(
            "Version {} checked in; the update from {} is done.",
            switch.to,
            switch.from
        );
        Ok(())
    }

    fn roll_back(&self, switch: &Switch, reason: &str) -> Result<()> {
        log::error!("Rolling back to version {}: {reason}.", switch.from);
        let layout = self.layout();
        if !layout.binary(Slot::Previous).exists() {
            bail!(
                "cannot roll back: {} is missing",
                layout.dir(Slot::Previous).display()
            );
        }
        layout.rename(Slot::Previous, Slot::Current)?;
        layout.end_switch()?;
        updates::record_event(
            &self.data_dir,
            UpdateEvent::RolledBack {
                version: switch.to.clone(),
                reason: reason.to_string(),
                at_ms: now_ms(),
            },
        )
    }

    /// Checks the waiting build again, with the launcher's own keys, and
    /// switches to it. A build that fails is refused and removed.
    fn switch_to_incoming(&self) -> Result<()> {
        let layout = self.layout();
        let current = layout.release(Slot::Current)?;
        let checked = layout.release(Slot::Incoming).and_then(|release| {
            let bytes = fs::read(layout.binary(Slot::Incoming))
                .context("could not read the downloaded build")?;
            Ok((release, bytes))
        });
        let (release, reason) = match checked {
            Ok((release, bytes)) => {
                let reason = check_build(&release, &bytes, &current.version, &self.keys).err();
                (Some(release), reason)
            }
            Err(e) => (None, Some(format!("{e:#}"))),
        };
        match (release, reason) {
            (Some(release), None) => {
                let switch = Switch {
                    from: current.version,
                    to: release.version,
                };
                // The switch file first: after a crash, `recover` can finish it.
                layout.begin_switch(&switch)?;
                layout.rename(Slot::Current, Slot::Previous)?;
                layout.rename(Slot::Incoming, Slot::Current)?;
                log::info!("Switched from version {} to {}.", switch.from, switch.to);
                Ok(())
            }
            (release, reason) => {
                let reason = reason.unwrap_or_default();
                let version = release.map_or_else(|| "(unknown)".to_string(), |r| r.version);
                log::error!("The launcher refused version {version}: {reason}.");
                layout.remove(Slot::Incoming)?;
                updates::record_event(
                    &self.data_dir,
                    UpdateEvent::Refused {
                        version,
                        reason,
                        at_ms: now_ms(),
                    },
                )
            }
        }
    }
}

/// The last [`TAIL_LINES`] lines of a worker's stderr, each also written to
/// the launcher's own stderr (the journal, on Linux).
struct Tail {
    lines: Arc<Mutex<VecDeque<String>>>,
    done: mpsc::Receiver<()>,
}

impl Tail {
    fn follow(stderr: Option<std::process::ChildStderr>) -> Tail {
        let lines = Arc::new(Mutex::new(VecDeque::new()));
        let (finished, done) = mpsc::channel();
        if let Some(stderr) = stderr {
            let kept = Arc::clone(&lines);
            let started = std::thread::Builder::new()
                .name("worker stderr".into())
                .spawn(move || {
                    for line in BufReader::new(stderr).split(b'\n') {
                        let Ok(line) = line else {
                            break;
                        };
                        let _ = std::io::stderr().write_all(&line);
                        let _ = std::io::stderr().write_all(b"\n");
                        let text = String::from_utf8_lossy(&line).trim_end().to_string();
                        let mut kept = kept.lock().unwrap_or_else(|p| p.into_inner());
                        if kept.len() == TAIL_LINES {
                            kept.pop_front();
                        }
                        kept.push_back(text);
                    }
                    let _ = finished.send(());
                });
            if let Err(error) = started {
                log::warn!("Could not read the agent's stderr: {error}");
            }
        }
        Tail { lines, done }
    }

    /// The lines so far, once the worker's stderr has closed (or a second
    /// has passed: a helper it started may still hold it open).
    fn lines(&self) -> Vec<String> {
        let _ = self.done.recv_timeout(Duration::from_secs(1));
        self.lines
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .iter()
            .cloned()
            .collect()
    }
}

/// How a worker ended: `info` for the planned exits, `error` otherwise.
fn describe_exit(status: &ExitStatus) -> (bmuster_protocol::logs::LogLevel, String) {
    use bmuster_protocol::logs::LogLevel;
    match status.code() {
        Some(EXIT_STOPPED) => (LogLevel::Info, "stopped cleanly".into()),
        Some(EXIT_RESTART) => (LogLevel::Info, "stopped to be started again".into()),
        Some(EXIT_REVOKED) => (
            LogLevel::Info,
            "stopped because the server removed this machine".into(),
        ),
        Some(code) if code == i32::from(EXIT_UPDATE) => {
            (LogLevel::Info, "stopped to switch to a new version".into())
        }
        Some(code) => (LogLevel::Error, format!("exited with code {code}")),
        None => (LogLevel::Error, describe_signal(status)),
    }
}

#[cfg(unix)]
fn describe_signal(status: &ExitStatus) -> String {
    use std::os::unix::process::ExitStatusExt as _;
    match status.signal() {
        Some(signal) => {
            let name = match signal {
                libc::SIGABRT => " (SIGABRT: a panic or an abort)",
                libc::SIGSEGV => " (SIGSEGV)",
                libc::SIGKILL => " (SIGKILL)",
                libc::SIGTERM => " (SIGTERM)",
                libc::SIGBUS => " (SIGBUS)",
                _ => "",
            };
            format!("was ended by signal {signal}{name}")
        }
        None => format!("ended ({status})"),
    }
}

#[cfg(not(unix))]
fn describe_signal(status: &ExitStatus) -> String {
    format!("ended ({status})")
}

fn describe_uptime(uptime: Duration) -> String {
    let seconds = uptime.as_secs();
    match seconds {
        0..=119 => format!("{seconds} s"),
        120..=7199 => format!("{} min", seconds / 60),
        _ => format!("{} h {} min", seconds / 3600, seconds / 60 % 60),
    }
}

/// Waits for the worker to exit; `None` if `stop` was set first.
fn wait(child: &mut Child, stop: &AtomicBool) -> Result<Option<ExitStatus>> {
    loop {
        if stop.load(Ordering::SeqCst) {
            return Ok(None);
        }
        if let Some(status) = child.try_wait().context("could not watch the agent")? {
            return Ok(Some(status));
        }
        std::thread::sleep(POLL);
    }
}

fn stop_child(child: &mut Child) {
    if matches!(child.try_wait(), Ok(None)) {
        let _ = child.kill();
    }
    let _ = child.wait();
}

/// Returns true if `stop` was set while waiting.
fn sleep_unless_stopped(wait: Duration, stop: &AtomicBool) -> bool {
    let until = Instant::now() + wait;
    while Instant::now() < until {
        if stop.load(Ordering::SeqCst) {
            return true;
        }
        std::thread::sleep(POLL.min(until.saturating_duration_since(Instant::now())));
    }
    stop.load(Ordering::SeqCst)
}

/// The version folders, for `status`.
pub fn describe(data_dir: &Path) -> Vec<(&'static str, String)> {
    let layout = Layout::new(data_dir);
    let version = |slot| {
        layout
            .release(slot)
            .map_or_else(|_| "none".to_string(), |release| release.version)
    };
    vec![
        ("Running:", version(Slot::Current)),
        ("Previous:", version(Slot::Previous)),
        (
            "Last update:",
            updates::describe(&updates::last_event(data_dir)),
        ),
    ]
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::updates::tests::{signed, test_key};
    use ed25519_dalek::SigningKey;
    use std::os::unix::fs::PermissionsExt as _;

    const OLD: &str = "1.0.0";
    const NEW: &str = "2.0.0";

    struct Rig {
        dir: tempfile::TempDir,
        launcher: Launcher,
    }

    impl Rig {
        /// `current` holds a fake worker (a shell script) as 1.0.0 and
        /// `incoming` another as 2.0.0 signed by `signer`. Each script body
        /// gets the data folder's path.
        fn new(
            old: impl Fn(&str) -> String,
            new: impl Fn(&str) -> String,
            signer: &SigningKey,
        ) -> Self {
            let dir = tempfile::tempdir().unwrap();
            let data = dir.path().display().to_string();
            let layout = Layout::new(dir.path());
            fs::create_dir_all(layout.root()).unwrap();
            for (slot, version, body) in [
                (Slot::Current, OLD, old(&data)),
                (Slot::Incoming, NEW, new(&data)),
            ] {
                let bytes = format!("#!/bin/sh\n{body}\n").into_bytes();
                layout
                    .store(slot, &signed(version, &bytes, signer), &bytes)
                    .unwrap();
                fs::set_permissions(layout.binary(slot), fs::Permissions::from_mode(0o700))
                    .unwrap();
            }
            let launcher = Launcher {
                data_dir: dir.path().to_path_buf(),
                worker_args: vec![],
                own_binary: PathBuf::from("/nonexistent"),
                own_version: OLD.into(),
                keys: vec![test_key().verifying_key()],
                health_window: Duration::from_secs(2),
                restart_delay: Duration::from_millis(50),
            };
            Self { dir, launcher }
        }

        fn current_version(&self) -> String {
            self.launcher
                .layout()
                .release(Slot::Current)
                .unwrap()
                .version
        }

        fn last(&self) -> UpdateEvent {
            updates::last_event(self.dir.path())
        }

        fn run(&self) -> Ended {
            self.launcher.run(&AtomicBool::new(false)).unwrap()
        }
    }

    /// The old worker: asks for the update the first time, then stops.
    fn old_worker(data: &str) -> String {
        format!(
            "if [ -e {data}/old-ran ]; then exit 0; fi\ntouch {data}/old-ran\nexit {EXIT_UPDATE}"
        )
    }

    #[test]
    fn an_update_that_checks_in_is_kept() {
        let rig = Rig::new(
            old_worker,
            |data| format!("printf {NEW} > {data}/versions/checked-in\nsleep 1\nexit 0"),
            &test_key(),
        );
        assert_eq!(rig.run(), Ended::Stopped);
        let layout = rig.launcher.layout();
        assert_eq!(rig.current_version(), NEW);
        assert_eq!(layout.release(Slot::Previous).unwrap().version, OLD);
        assert!(layout.switch().unwrap().is_none());
        assert!(matches!(
            rig.last(),
            UpdateEvent::Updated { ref from, ref to, .. } if from == OLD && to == NEW
        ));
    }

    #[test]
    fn an_update_that_stops_before_checking_in_is_rolled_back() {
        let rig = Rig::new(old_worker, |_| "exit 1".into(), &test_key());
        assert_eq!(rig.run(), Ended::Stopped);
        assert_eq!(rig.current_version(), OLD);
        match rig.last() {
            UpdateEvent::RolledBack {
                version, reason, ..
            } => {
                assert_eq!(version, NEW);
                assert!(reason.contains("stopped before it checked in"), "{reason}");
            }
            other => panic!("expected a rollback, got {other:?}"),
        }
        assert!(rig.launcher.layout().switch().unwrap().is_none());
    }

    #[test]
    fn an_update_that_never_checks_in_is_rolled_back_at_the_deadline() {
        let rig = Rig::new(old_worker, |_| "sleep 30".into(), &test_key());
        let started = Instant::now();
        assert_eq!(rig.run(), Ended::Stopped);
        assert!(started.elapsed() < Duration::from_secs(20));
        assert_eq!(rig.current_version(), OLD);
        assert!(matches!(
            rig.last(),
            UpdateEvent::RolledBack { ref reason, .. } if reason.contains("did not check in within 2 s")
        ));
    }

    #[test]
    fn a_marker_from_another_version_does_not_count() {
        let rig = Rig::new(
            old_worker,
            |data| format!("printf {OLD} > {data}/versions/checked-in\nsleep 30"),
            &test_key(),
        );
        assert_eq!(rig.run(), Ended::Stopped);
        assert_eq!(rig.current_version(), OLD);
        assert!(matches!(rig.last(), UpdateEvent::RolledBack { .. }));
    }

    #[test]
    fn the_launcher_refuses_a_build_signed_by_another_key() {
        let rig = Rig::new(
            old_worker,
            |_| "exit 0".into(),
            &SigningKey::from_bytes(&[3; 32]),
        );
        assert_eq!(rig.run(), Ended::Stopped);
        assert_eq!(rig.current_version(), OLD);
        assert!(!rig.launcher.layout().dir(Slot::Incoming).exists());
        assert!(matches!(
            rig.last(),
            UpdateEvent::Refused { ref reason, .. } if reason.contains("not from a release key")
        ));
    }

    /// SPEC-DIAGNOSTICS D6.
    #[test]
    fn worker_exit_is_recorded() {
        // First run: 25 lines on stderr, then a crash; second: a clean stop.
        let rig = Rig::new(
            |data| {
                format!(
                    "if [ -e {data}/crashed ]; then exit 0; fi\ntouch {data}/crashed\n\
                     i=0; while [ $i -lt 25 ]; do echo \"line $i\" >&2; i=$((i+1)); done\nexit 1"
                )
            },
            |_| "exit 0".into(),
            &test_key(),
        );
        assert_eq!(rig.run(), Ended::Stopped);
        let spool = crate::log_spool::Spool::open(
            &rig.dir.path().join(crate::log_spool::SPOOL_DIR),
            "00000000-0000-4000-8000-000000000003",
        )
        .unwrap();
        let (_, records) = spool.next_batch(500).unwrap();
        let exits: Vec<_> = records
            .iter()
            .filter(|record| record.target == EXIT_TARGET)
            .collect();
        assert_eq!(exits.len(), 2, "{records:?}");
        let crash = &exits[0];
        assert_eq!(crash.level, bmuster_protocol::logs::LogLevel::Error);
        assert!(
            crash.text.starts_with("The agent exited with code 1 after"),
            "{}",
            crash.text
        );
        assert!(crash.text.contains("its last 20 lines on stderr"));
        assert!(crash.text.contains("line 24"));
        assert!(crash.text.contains("line 5\n"));
        assert!(!crash.text.contains("line 4\n"), "only the last 20 lines");
        assert_eq!(exits[1].level, bmuster_protocol::logs::LogLevel::Info);
        assert!(exits[1].text.starts_with("The agent stopped cleanly"));
    }

    #[test]
    fn revoked_and_restart_exits_are_followed() {
        // The first run asks for a restart, the second says revoked.
        let rig = Rig::new(
            |data| {
                format!("if [ -e {data}/ran ]; then exit {EXIT_REVOKED}; fi\ntouch {data}/ran\nexit {EXIT_RESTART}")
            },
            |_| "exit 0".into(),
            &test_key(),
        );
        assert_eq!(rig.run(), Ended::Revoked);
    }

    #[test]
    fn an_interrupted_switch_is_finished_and_a_missing_current_seeded() {
        let rig = Rig::new(|_| "exit 0".into(), |_| "exit 0".into(), &test_key());
        let layout = rig.launcher.layout();
        layout
            .begin_switch(&Switch {
                from: OLD.into(),
                to: NEW.into(),
            })
            .unwrap();
        layout.rename(Slot::Current, Slot::Previous).unwrap();
        rig.launcher.recover().unwrap();
        assert_eq!(rig.current_version(), NEW);

        let fresh = tempfile::tempdir().unwrap();
        let own = fresh.path().join("launcher");
        fs::write(&own, b"launcher bytes").unwrap();
        let seeding = Launcher {
            data_dir: fresh.path().join("data"),
            own_binary: own,
            ..rig.launcher
        };
        seeding.recover().unwrap();
        let seeded = seeding.layout().release(Slot::Current).unwrap();
        assert_eq!(seeded.version, OLD);
        assert_eq!(seeded.size, 14);
    }
}
