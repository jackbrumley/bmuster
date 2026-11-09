//! Moving an installed agent's program files from /var/lib/bmuster/versions
//! to /opt/bmuster/versions (SPEC-SESSION-UNITS, Version 3, design step 5).
//!
//! systemd may not run a program stored under /var/lib (SELinux:
//! `var_lib_t`), so agents installed with 0.4.1–0.4.4 cannot start session
//! units. Their unit's sandbox cannot write /opt or /etc, so the new worker,
//! still started from /var/lib, has systemd run fixed system programs as
//! short transient units (each a plain `bin_t` program systemd may run):
//!
//! 1. `/usr/bin/install -D` copies `current` (and `previous`) into
//!    `/opt/bmuster/versions/<version>/`: written there, so the files take
//!    the folder's label;
//! 2. `/usr/bin/ln -sfn` points the `current` and `previous` links at them;
//! 3. `/usr/bin/install -m 0644` puts this version's unit files (staged in
//!    `/var/lib/bmuster/staged-units/`) in /etc/systemd/system, then
//!    `/usr/bin/systemctl daemon-reload`.
//!
//! Each step looks first and runs only when its result is missing, so the
//! move is idempotent; a failed step stops the move, is logged with what
//! failed, and the next start tries again. Once this version has checked
//! in and no session runs, `/usr/bin/install -m 0755` makes its /opt copy
//! the rescue copy (the old one only knows /var/lib), and the worker
//! restarts the service, which then starts from /opt. After the
//! first check-in from /opt the old folder is deleted.
//!
//! Nothing here changes an SELinux label or policy.

use crate::identity::write_private;
use crate::sessions::Sessions;
use crate::updates::{BINARY_NAME, RELEASE_FILE};
use anyhow::{bail, Context as _, Result};
use bmuster_protocol::AgentVersion;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

/// The versions folder of installs from before Version 3.
const OLD_VERSIONS: &str = "versions";
/// Unit files written here first, then installed by `/usr/bin/install`.
const STAGED_UNITS: &str = "staged-units";
/// How often the worker looks for a moment without sessions to restart.
const IDLE_POLL: Duration = Duration::from_secs(30);

const INSTALL: &str = "/usr/bin/install";
const LN: &str = "/usr/bin/ln";
const SYSTEMCTL: &str = "/usr/bin/systemctl";

/// One fixed system program and its arguments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Step {
    pub program: &'static str,
    pub args: Vec<OsString>,
}

impl Step {
    fn new(program: &'static str, args: &[&std::ffi::OsStr]) -> Self {
        Self {
            program,
            args: args.iter().map(|arg| arg.to_os_string()).collect(),
        }
    }

    fn describe(&self) -> String {
        let args: Vec<String> = self
            .args
            .iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect();
        format!("{} {}", self.program, args.join(" "))
    }
}

/// Runs a step as a transient unit; the error says why it failed.
pub trait Runner {
    fn run(&mut self, step: &Step) -> std::result::Result<(), String>;
}

/// The folders and unit files a move works on.
pub struct Places {
    /// `/var/lib/bmuster/versions`: `current/` and `previous/` folders.
    pub old_versions: PathBuf,
    /// `/opt/bmuster/versions`.
    pub versions: PathBuf,
    /// `/var/lib/bmuster/staged-units`.
    pub staged_units: PathBuf,
    /// Each unit file's path and the text this version writes.
    pub units: Vec<(PathBuf, String)>,
    /// `/opt/bmuster/bmuster-agent`: the rescue copy.
    pub rescue: PathBuf,
}

impl Places {
    fn installed(data_dir: &Path) -> Self {
        Self {
            old_versions: data_dir.join(OLD_VERSIONS),
            versions: crate::paths::versions_dir(data_dir),
            staged_units: data_dir.join(STAGED_UNITS),
            units: crate::service_linux::unit_files().into_iter().collect(),
            rescue: crate::service_linux::rescue_copy(),
        }
    }
}

/// After this version checked in (it is healthy), before the restart: its
/// /opt copy becomes the rescue copy, so a launcher that fails to start
/// from /opt is rolled back by rescue code that knows the /opt layout (the
/// 0.4.4 copy only knows /var/lib/bmuster/versions, which is deleted).
/// One fixed step, `/usr/bin/install -m 0755`, run only when the rescue
/// copy differs. Returns whether it ran.
pub fn refresh_rescue_copy(
    places: &Places,
    version: &str,
    runner: &mut dyn Runner,
) -> Result<bool> {
    let version = AgentVersion::parse(version)?.as_str().to_string();
    let source = places.versions.join(&version).join(BINARY_NAME);
    let wanted =
        fs::read(&source).with_context(|| format!("could not read {}", source.display()))?;
    if fs::read(&places.rescue).ok().as_deref() == Some(wanted.as_slice()) {
        return Ok(false);
    }
    let step = Step::new(
        INSTALL,
        &[
            "-m".as_ref(),
            "0755".as_ref(),
            source.as_os_str(),
            places.rescue.as_os_str(),
        ],
    );
    runner
        .run(&step)
        .map_err(|reason| anyhow::anyhow!("{} failed: {reason}", step.describe()))?;
    Ok(true)
}

/// Whether anything had to be done.
#[derive(Debug, PartialEq, Eq)]
pub enum Moved {
    AlreadyThere,
    Moved { steps: usize },
}

/// Moves the program files and units (design step 5). Only the fixed
/// programs [`INSTALL`], [`LN`] and [`SYSTEMCTL`] run, each step only when
/// its result is missing; the first failure stops the move with its reason.
pub fn move_from_var_lib(places: &Places, runner: &mut dyn Runner) -> Result<Moved> {
    let mut steps = 0;
    let mut run = |step: Step| -> Result<()> {
        steps += 1;
        runner
            .run(&step)
            .map_err(|reason| anyhow::anyhow!("{} failed: {reason}", step.describe()))
    };

    // 1. The program files, copied (never renamed) into /opt.
    let mut links = Vec::new();
    for slot in ["current", "previous"] {
        let folder = places.old_versions.join(slot);
        let Ok(text) = fs::read_to_string(folder.join(RELEASE_FILE)) else {
            continue;
        };
        let release: crate::updates::Release = serde_json::from_str(&text)
            .with_context(|| format!("{} is damaged", folder.join(RELEASE_FILE).display()))?;
        let version = AgentVersion::parse(&release.version)?.as_str().to_string();
        for (file, mode) in [(BINARY_NAME, "0755"), (RELEASE_FILE, "0644")] {
            let source = folder.join(file);
            let target = places.versions.join(&version).join(file);
            let wanted = fs::read(&source)
                .with_context(|| format!("could not read {}", source.display()))?;
            if fs::read(&target).ok().as_deref() != Some(wanted.as_slice()) {
                run(Step::new(
                    INSTALL,
                    &[
                        "-D".as_ref(),
                        "-m".as_ref(),
                        mode.as_ref(),
                        source.as_os_str(),
                        target.as_os_str(),
                    ],
                ))?;
            }
        }
        links.push((slot, version));
    }
    if links.is_empty() {
        bail!("{} holds no version to move", places.old_versions.display());
    }

    // 2. The links.
    for (slot, version) in &links {
        let link = places.versions.join(slot);
        if fs::read_link(&link).ok().as_deref() != Some(Path::new(version)) {
            run(Step::new(
                LN,
                &["-sfn".as_ref(), version.as_ref(), link.as_os_str()],
            ))?;
        }
    }

    // 3. The unit files, then one reload. Staged files left by an earlier
    // run mean its reload did not happen yet.
    let mut changed = places.staged_units.exists();
    for (path, text) in &places.units {
        if fs::read_to_string(path).ok().as_deref() == Some(text.as_str()) {
            continue;
        }
        let name = path
            .file_name()
            .with_context(|| format!("{} names no file", path.display()))?;
        fs::create_dir_all(&places.staged_units)
            .with_context(|| format!("could not create {}", places.staged_units.display()))?;
        let staged = places.staged_units.join(name);
        write_private(&staged, text.as_bytes())?;
        run(Step::new(
            INSTALL,
            &[
                "-m".as_ref(),
                "0644".as_ref(),
                staged.as_os_str(),
                path.as_os_str(),
            ],
        ))?;
        changed = true;
    }
    if changed {
        run(Step::new(SYSTEMCTL, &["daemon-reload".as_ref()]))?;
        fs::remove_dir_all(&places.staged_units)
            .with_context(|| format!("could not remove {}", places.staged_units.display()))?;
    }
    Ok(match steps {
        0 => Moved::AlreadyThere,
        steps => Moved::Moved { steps },
    })
}

/// Whether `program` runs from the old versions folder.
pub fn runs_from_var_lib(program: &Path) -> bool {
    crate::paths::default_data_dir().is_ok_and(|data| program.starts_with(data.join(OLD_VERSIONS)))
}

fn this_runs_from_var_lib() -> bool {
    std::env::current_exe().is_ok_and(|program| runs_from_var_lib(&program))
}

/// Whether this installed agent still runs from /var/lib, before its
/// restart from /opt: it cannot write new versions there yet.
pub fn pending(data_dir: &Path) -> bool {
    crate::paths::is_installed_data_dir(data_dir) && this_runs_from_var_lib()
}

/// Runs each step with `systemd-run --wait` as its own short unit.
struct SystemdRunner {
    count: u32,
}

impl Runner for SystemdRunner {
    fn run(&mut self, step: &Step) -> std::result::Result<(), String> {
        self.count += 1;
        let output = Command::new("systemd-run")
            .args(["--quiet", "--wait", "--collect", "--service-type=exec"])
            .arg(format!(
                "--unit=bmuster-agent-move-{}-{}",
                std::process::id(),
                self.count
            ))
            .arg("--")
            .arg(step.program)
            .args(&step.args)
            .stdin(Stdio::null())
            .output()
            .map_err(|error| format!("could not run systemd-run: {error}"))?;
        if output.status.success() {
            Ok(())
        } else {
            Err(format!(
                "{} {}",
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            ))
        }
    }
}

/// From the worker's start: when this install still runs from
/// /var/lib/bmuster/versions, moves it and restarts the service from /opt
/// as soon as no session runs.
pub fn start(data_dir: &Path, launched: bool, sessions: Sessions) {
    if !launched || !crate::paths::is_installed_data_dir(data_dir) || !this_runs_from_var_lib() {
        return;
    }
    let data_dir = data_dir.to_path_buf();
    let started = std::thread::Builder::new()
        .name("move to /opt".into())
        .spawn(move || {
            carry_rescue_record(&data_dir);
            let mut runner = SystemdRunner { count: 0 };
            match move_from_var_lib(&Places::installed(&data_dir), &mut runner) {
                Ok(_) => log::info!(
                    "Moved the program files to /opt/bmuster; they apply from the next start."
                ),
                Err(error) => {
                    log::error!(
                        "Could not move the program files to /opt/bmuster: {error:#}. \
                         Trying again at the next start."
                    );
                    return;
                }
            }
            let places = Places::installed(&data_dir);
            let marker = crate::updates::Layout::new(&data_dir).checked_in_marker();
            let mut warned = false;
            loop {
                std::thread::sleep(IDLE_POLL);
                // An older launcher commits its switch to this version
                // only after the first check-in; restarting before that
                // would leave the switch on trial.
                let on_trial = data_dir.join(OLD_VERSIONS).join("switch.json").exists();
                let healthy = fs::read_to_string(&marker)
                    .is_ok_and(|version| version == crate::updates::VERSION);
                if sessions.running() > 0 || on_trial || !healthy {
                    continue;
                }
                match refresh_rescue_copy(&places, crate::updates::VERSION, &mut runner) {
                    Ok(ran) => {
                        if ran {
                            log::info!(
                                "Version {} is the rescue copy now.",
                                crate::updates::VERSION
                            );
                        }
                        if let Err(error) =
                            crate::rescue::record_version(&data_dir, crate::updates::VERSION)
                        {
                            log::warn!("Could not record the rescue copy's version: {error:#}");
                        }
                        break;
                    }
                    // The restart waits: the old rescue copy cannot roll
                    // back a launcher in /opt.
                    Err(error) if !warned => {
                        warned = true;
                        log::error!(
                            "Could not make this version the rescue copy: {error:#}; \
                             trying again before restarting."
                        );
                    }
                    Err(error) => log::debug!("Rescue copy still not refreshed: {error:#}"),
                }
            }
            log::info!("No session is running; restarting the agent to run from /opt/bmuster.");
            let restart = Step::new(
                SYSTEMCTL,
                &[
                    "restart".as_ref(),
                    "--no-block".as_ref(),
                    crate::service_linux::UNIT_NAME.as_ref(),
                ],
            );
            if let Err(reason) = runner.run(&restart) {
                log::error!("Could not restart the agent: {reason}");
            }
        });
    if let Err(error) = started {
        log::error!("Could not start moving the program files: {error}");
    }
}

/// The rescue copy's record lived in the old versions folder.
fn carry_rescue_record(data_dir: &Path) {
    let old = data_dir.join(OLD_VERSIONS).join("rescue-copy.json");
    let new = crate::rescue::record_path(data_dir);
    if new.exists() || !old.exists() {
        return;
    }
    if let Err(error) = fs::read(&old)
        .map_err(anyhow::Error::from)
        .and_then(|bytes| write_private(&new, &bytes))
    {
        log::warn!("Could not carry over the rescue copy's record: {error:#}");
    }
}

/// After a check-in. Under an older launcher (still in /var/lib), also
/// leaves the marker where it looks, so it keeps this version. From /opt,
/// deletes the old versions folder: the start from /opt was healthy.
pub fn checked_in(data_dir: &Path) {
    if !crate::paths::is_installed_data_dir(data_dir) {
        return;
    }
    let old = data_dir.join(OLD_VERSIONS);
    if this_runs_from_var_lib() {
        let marker = old.join("checked-in");
        if let Err(error) = write_private(&marker, crate::updates::VERSION.as_bytes()) {
            log::error!("Could not tell the older launcher this version works: {error:#}");
        }
    } else if old.exists() {
        match fs::remove_dir_all(&old) {
            Ok(()) => log::info!(
                "Removed {}: the agent runs from /opt/bmuster.",
                old.display()
            ),
            Err(error) => log::warn!("Could not remove {}: {error}", old.display()),
        }
    }
}

/// For a launcher started from /var/lib: an older launcher's switch to
/// this version is over (the launcher itself started), so it is recorded
/// as an update and its record removed.
pub fn end_old_switch(data_dir: &Path, version: &str) {
    let path = data_dir.join(OLD_VERSIONS).join("switch.json");
    let Ok(text) = fs::read_to_string(&path) else {
        return;
    };
    if let Ok(switch) = serde_json::from_str::<crate::updates::Switch>(&text) {
        if switch.to == version {
            let event = bmuster_protocol::UpdateEvent::Updated {
                from: switch.from,
                to: switch.to,
                at_ms: crate::updates::now_ms(),
            };
            if let Err(error) = crate::updates::record_event(data_dir, event) {
                log::warn!("Could not record the update: {error:#}");
            }
        }
    }
    if let Err(error) = fs::remove_file(&path) {
        log::warn!("Could not remove {}: {error}", path.display());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt as _;

    /// Does what the fixed programs would, in a scratch folder, and fails
    /// the `fail_at`-th step (1-based) once.
    struct FakeRunner {
        steps: Vec<Step>,
        fail_at: Option<usize>,
    }

    impl Runner for FakeRunner {
        fn run(&mut self, step: &Step) -> std::result::Result<(), String> {
            self.steps.push(step.clone());
            if self.fail_at == Some(self.steps.len()) {
                self.fail_at = None;
                return Err("exit status: 1 (a test failure)".into());
            }
            let args: Vec<&str> = step.args.iter().map(|a| a.to_str().unwrap()).collect();
            match (step.program, args.as_slice()) {
                (INSTALL, ["-D", "-m", mode, source, target] | ["-m", mode, source, target]) => {
                    let target = Path::new(target);
                    fs::create_dir_all(target.parent().unwrap()).unwrap();
                    fs::copy(source, target).unwrap();
                    let mode = u32::from_str_radix(mode, 8).unwrap();
                    fs::set_permissions(target, fs::Permissions::from_mode(mode)).unwrap();
                }
                (LN, ["-sfn", version, link]) => {
                    let _ = fs::remove_file(link);
                    std::os::unix::fs::symlink(version, link).unwrap();
                }
                (SYSTEMCTL, ["daemon-reload"]) => {}
                other => panic!("not a fixed step: {other:?}"),
            }
            Ok(())
        }
    }

    /// An install as 0.4.1–0.4.4 left it: current 2.0.0, previous 1.0.0,
    /// old unit files.
    fn old_install(root: &Path) -> Places {
        let old_versions = root.join("var-lib/versions");
        for (slot, version) in [("current", "2.0.0"), ("previous", "1.0.0")] {
            let folder = old_versions.join(slot);
            fs::create_dir_all(&folder).unwrap();
            fs::write(folder.join(BINARY_NAME), format!("agent {version}")).unwrap();
            let release = crate::updates::Release {
                version: version.into(),
                target: crate::updates::TARGET.into(),
                size: 9,
                sha256: "0".repeat(64),
                signature: String::new(),
            };
            fs::write(
                folder.join(RELEASE_FILE),
                serde_json::to_vec(&release).unwrap(),
            )
            .unwrap();
        }
        let units = root.join("etc");
        fs::create_dir_all(&units).unwrap();
        fs::write(units.join("bmuster-agent.service"), "old unit").unwrap();
        fs::write(units.join("bmuster-agent-rescue.service"), "rescue unit").unwrap();
        fs::create_dir_all(root.join("opt")).unwrap();
        fs::write(root.join("opt/bmuster-agent"), "agent 0.4.4").unwrap();
        Places {
            old_versions,
            versions: root.join("opt/versions"),
            staged_units: root.join("var-lib/staged-units"),
            units: vec![
                (units.join("bmuster-agent.service"), "new unit".into()),
                (
                    units.join("bmuster-agent-rescue.service"),
                    "rescue unit".into(),
                ),
            ],
            rescue: root.join("opt/bmuster-agent"),
        }
    }

    fn moved_completely(places: &Places) {
        for (slot, version) in [("current", "2.0.0"), ("previous", "1.0.0")] {
            let link = places.versions.join(slot);
            assert_eq!(fs::read_link(&link).unwrap(), Path::new(version));
            assert_eq!(
                fs::read_to_string(link.join(BINARY_NAME)).unwrap(),
                format!("agent {version}")
            );
            let mode = fs::metadata(link.join(BINARY_NAME))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o755);
        }
        for (path, text) in &places.units {
            assert_eq!(&fs::read_to_string(path).unwrap(), text);
        }
        assert!(!places.staged_units.exists());
    }

    /// SPEC-SESSION-UNITS O4.
    #[test]
    fn move_from_var_lib_steps() {
        let root = tempfile::tempdir().unwrap();
        let places = old_install(root.path());
        let mut runner = FakeRunner {
            steps: Vec::new(),
            fail_at: None,
        };
        assert_eq!(
            move_from_var_lib(&places, &mut runner).unwrap(),
            Moved::Moved { steps: 8 }
        );
        moved_completely(&places);
        // Only the fixed system programs, in order: copies, links, units.
        let programs: Vec<&str> = runner.steps.iter().map(|step| step.program).collect();
        assert_eq!(
            programs,
            [INSTALL, INSTALL, INSTALL, INSTALL, LN, LN, INSTALL, SYSTEMCTL]
        );
        let copy = &runner.steps[0];
        assert_eq!(copy.args[0], "-D", "written into /opt, never renamed");
        assert!(runner.steps.iter().all(|step| step
            .args
            .iter()
            .all(|arg| !arg.to_string_lossy().contains("chcon"))));
        assert_eq!(runner.steps[6].args[..2], ["-m", "0644"]);
        assert_eq!(runner.steps[7].args, ["daemon-reload"]);

        // Idempotent: a second run does nothing.
        let mut again = FakeRunner {
            steps: Vec::new(),
            fail_at: None,
        };
        assert_eq!(
            move_from_var_lib(&places, &mut again).unwrap(),
            Moved::AlreadyThere
        );
        assert!(again.steps.is_empty());

        // Each step failing: the move stops with the reason, and the next
        // start finishes it, running only what is left.
        for fail_at in 1..=8 {
            let root = tempfile::tempdir().unwrap();
            let places = old_install(root.path());
            let mut failing = FakeRunner {
                steps: Vec::new(),
                fail_at: Some(fail_at),
            };
            let error = move_from_var_lib(&places, &mut failing)
                .unwrap_err()
                .to_string();
            assert!(error.contains("failed: exit status: 1"), "{error}");
            assert_eq!(failing.steps.len(), fail_at, "stops at the failure");
            let mut next_start = FakeRunner {
                steps: Vec::new(),
                fail_at: None,
            };
            move_from_var_lib(&places, &mut next_start).unwrap();
            moved_completely(&places);
            assert_eq!(
                next_start.steps.len(),
                8 - fail_at + 1,
                "step {fail_at}: only the rest runs again"
            );
        }

        // After the check-in: this version's /opt copy becomes the rescue
        // copy, with one fixed step, once.
        let mut rescue = FakeRunner {
            steps: Vec::new(),
            fail_at: None,
        };
        assert!(refresh_rescue_copy(&places, "2.0.0", &mut rescue).unwrap());
        assert_eq!(fs::read_to_string(&places.rescue).unwrap(), "agent 2.0.0");
        let mode = fs::metadata(&places.rescue).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o755);
        assert_eq!(rescue.steps.len(), 1);
        assert_eq!(rescue.steps[0].program, INSTALL);
        assert_eq!(
            rescue.steps[0].args,
            [
                OsString::from("-m"),
                "0755".into(),
                places.versions.join("2.0.0").join(BINARY_NAME).into(),
                places.rescue.clone().into(),
            ]
        );
        assert!(!refresh_rescue_copy(&places, "2.0.0", &mut rescue).unwrap());
        assert_eq!(rescue.steps.len(), 1, "idempotent");

        // The rescue step failing: the old copy stays, the next try works.
        let root = tempfile::tempdir().unwrap();
        let places = old_install(root.path());
        move_from_var_lib(
            &places,
            &mut FakeRunner {
                steps: Vec::new(),
                fail_at: None,
            },
        )
        .unwrap();
        let mut failing = FakeRunner {
            steps: Vec::new(),
            fail_at: Some(1),
        };
        let error = refresh_rescue_copy(&places, "2.0.0", &mut failing)
            .unwrap_err()
            .to_string();
        assert!(error.contains("failed: exit status: 1"), "{error}");
        assert_eq!(fs::read_to_string(&places.rescue).unwrap(), "agent 0.4.4");
        assert!(refresh_rescue_copy(&places, "2.0.0", &mut failing).unwrap());
        assert_eq!(fs::read_to_string(&places.rescue).unwrap(), "agent 2.0.0");
        // Only a version's own folder under /opt is ever the source.
        assert!(refresh_rescue_copy(&places, "../2.0.0", &mut failing).is_err());

        // Nothing to move from is an error, not a silent success.
        let empty = tempfile::tempdir().unwrap();
        let mut places = old_install(empty.path());
        places.old_versions = empty.path().join("nothing");
        assert!(move_from_var_lib(&places, &mut runner).is_err());
    }
}
