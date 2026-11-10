//! StatusNotifierItem in the user's bus; no GTK or privileged process.
use super::status;
use crate::move_to_opt::{Runner, Step, SystemdRunner, INSTALL};
use anyhow::{Context as _, Result};
use ksni::blocking::TrayMethods as _;
use ksni::menu::StandardItem;
use ksni::{Icon, MenuItem, Tray};
use std::path::{Path, PathBuf};

struct AgentTray {
    state: String,
    enabled: bool,
    clipboard: Option<arboard::Clipboard>,
}

impl AgentTray {
    fn refresh(&mut self) {
        match status::read() {
            Ok(snapshot) => {
                self.state = snapshot.state.label().into();
                self.enabled = true;
            }
            Err(error) => {
                self.state = format!("Agent not running: {error:#}");
                self.enabled = false;
            }
        }
    }
    fn action(&mut self, copy: bool) {
        let result = if copy {
            super::copy_url(&mut self.clipboard)
        } else {
            super::open_management()
        };
        if let Err(error) = result {
            self.state = format!(
                "Cannot {}: {error:#}",
                if copy { "copy URL" } else { "open management" }
            );
            log::warn!("{}", self.state);
        }
    }
}

impl Tray for AgentTray {
    fn id(&self) -> String {
        "org.bmuster.Agent".into()
    }
    fn title(&self) -> String {
        format!("BMuster: {}", self.state)
    }
    fn icon_pixmap(&self) -> Vec<Icon> {
        vec![Icon {
            width: 32,
            height: 32,
            data: super::icon_pixels(),
        }]
    }
    fn activate(&mut self, _: i32, _: i32) {
        self.action(false);
    }
    fn menu(&self) -> Vec<MenuItem<Self>> {
        vec![
            StandardItem {
                label: format!("BMuster: {}", self.state),
                enabled: false,
                ..Default::default()
            }
            .into(),
            StandardItem {
                label: "Open local management".into(),
                enabled: self.enabled,
                activate: Box::new(|tray: &mut Self| tray.action(false)),
                ..Default::default()
            }
            .into(),
            StandardItem {
                label: "Copy local URL".into(),
                enabled: self.enabled,
                activate: Box::new(|tray: &mut Self| tray.action(true)),
                ..Default::default()
            }
            .into(),
        ]
    }
    fn watcher_offline(&self, reason: ksni::OfflineReason) -> bool {
        log::warn!("No tray host ({reason:?}); use BMuster in the applications menu to open local management");
        true
    }
}

pub fn run() -> Result<()> {
    let mut tray = AgentTray {
        state: String::new(),
        enabled: false,
        clipboard: None,
    };
    tray.refresh();
    let handle = tray.assume_sni_available(true).spawn()?;
    while !handle.is_closed() {
        std::thread::sleep(std::time::Duration::from_secs(5));
        handle.update(AgentTray::refresh);
    }
    Ok(())
}

/// The autostart entry's path, which the `tray` check reads.
pub const AUTOSTART: &str = "/etc/xdg/autostart/bmuster-agent.desktop";
/// The staging folder for rewritten shortcuts, under the data folder.
const STAGED_SHORTCUTS: &str = "staged-shortcuts";

/// The autostart entry and the applications-menu entry, each with the text
/// this version writes: both start the current program under /opt
/// (SPEC-TRAY-SESSIONS 5).
pub fn shortcuts() -> [(&'static str, String); 2] {
    let program = crate::paths::CURRENT_PROGRAM;
    [
        (AUTOSTART, format!("[Desktop Entry]\nType=Application\nName=BMuster Agent\nComment=Show the BMuster connection status\nExec={program} tray\nIcon=network-workgroup\nTerminal=false\nX-GNOME-Autostart-enabled=true\n")),
        ("/usr/share/applications/bmuster-agent.desktop", format!("[Desktop Entry]\nType=Application\nName=BMuster\nComment=Open this computer's BMuster management page\nExec={program} tray --open\nIcon=network-workgroup\nTerminal=false\nCategories=System;RemoteAccess;\n")),
    ]
}

/// From the worker's start: each shortcut whose text differs from this
/// version's is staged in `staged` and put in place by `/usr/bin/install`,
/// run by `runner`, since the service's sandbox cannot write /etc or /usr.
/// Returns how many it rewrote.
pub fn refresh_shortcuts(
    entries: &[(PathBuf, String)],
    staged: &Path,
    runner: &mut dyn Runner,
) -> Result<usize> {
    let mut rewritten = 0;
    for (path, text) in entries {
        if std::fs::read_to_string(path).ok().as_deref() == Some(text.as_str()) {
            continue;
        }
        let name = path
            .file_name()
            .with_context(|| format!("{} names no file", path.display()))?;
        std::fs::create_dir_all(staged)
            .with_context(|| format!("could not create {}", staged.display()))?;
        let source = staged.join(name);
        crate::identity::write_private(&source, text.as_bytes())?;
        let step = Step::new(
            INSTALL,
            &[
                "-D".as_ref(),
                "-m".as_ref(),
                "0644".as_ref(),
                source.as_os_str(),
                path.as_os_str(),
            ],
        );
        runner
            .run(&step)
            .map_err(|reason| anyhow::anyhow!("{} failed: {reason}", step.describe()))?;
        rewritten += 1;
    }
    if staged.exists() {
        std::fs::remove_dir_all(staged)
            .with_context(|| format!("could not remove {}", staged.display()))?;
    }
    Ok(rewritten)
}

/// Rewrites the installed shortcuts that differ, on a thread of its own.
pub fn refresh_installed_shortcuts(data_dir: &Path) {
    let staged = data_dir.join(STAGED_SHORTCUTS);
    let started = std::thread::Builder::new()
        .name("tray shortcuts".into())
        .spawn(move || {
            let entries: Vec<(PathBuf, String)> = shortcuts()
                .into_iter()
                .map(|(path, text)| (PathBuf::from(path), text))
                .collect();
            let mut runner = SystemdRunner::new("shortcuts");
            match refresh_shortcuts(&entries, &staged, &mut runner) {
                Ok(0) => {}
                Ok(count) => log::info!(
                    "Rewrote {count} tray shortcut{} to start {}.",
                    if count == 1 { "" } else { "s" },
                    crate::paths::CURRENT_PROGRAM
                ),
                Err(error) => log::warn!("Could not rewrite the tray shortcuts: {error:#}"),
            }
        });
    if let Err(error) = started {
        log::warn!("Could not start rewriting the tray shortcuts: {error}");
    }
}

/// The helper's single-instance lock: `flock` on `bmuster-tray.lock` in
/// `runtime` (the person's `XDG_RUNTIME_DIR`), opened without following a
/// link. `None` when another helper of the same person holds it; the lock
/// frees when the returned file closes.
pub fn single_instance(runtime: &Path) -> Result<Option<std::fs::File>> {
    use std::os::fd::AsRawFd as _;
    use std::os::unix::fs::OpenOptionsExt as _;
    let path = runtime.join("bmuster-tray.lock");
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&path)
        .with_context(|| format!("could not open {}", path.display()))?;
    // SAFETY: the descriptor stays open for the whole call.
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
        return Ok(Some(file));
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::EWOULDBLOCK) {
        return Ok(None);
    }
    Err(anyhow::Error::from(error).context(format!("could not lock {}", path.display())))
}

/// The person's runtime folder: `XDG_RUNTIME_DIR`, else `/run/user/<uid>`.
pub fn runtime_dir() -> PathBuf {
    match std::env::var_os("XDG_RUNTIME_DIR") {
        Some(dir) if !dir.is_empty() => PathBuf::from(dir),
        // SAFETY: getuid has no arguments and cannot fail.
        _ => PathBuf::from(format!("/run/user/{}", unsafe { libc::getuid() })),
    }
}

/// Run by the installer, as root outside the service's sandbox.
pub fn install() -> Result<()> {
    for (path, content) in shortcuts() {
        let path = std::path::Path::new(path);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, content)?;
    }
    Ok(())
}

pub fn uninstall() -> Result<()> {
    for (path, _) in shortcuts() {
        match std::fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{Path, PathBuf, Runner, Step, INSTALL};

    /// SPEC-AGENT-TRAY T5.
    #[test]
    fn tray_shortcuts_and_autostart() {
        let entries = super::shortcuts();
        assert_eq!(entries[0].0, super::AUTOSTART);
        assert!(entries[0]
            .1
            .contains("Exec=/opt/bmuster/versions/current/bmuster-agent tray\n"));
        assert!(entries[1]
            .1
            .contains("Exec=/opt/bmuster/versions/current/bmuster-agent tray --open\n"));
        for (_, content) in entries {
            assert!(!content.contains("sudo"));
            assert!(!content.contains(" launch"));
        }
    }

    /// Copies as `/usr/bin/install -D -m 0644` would.
    #[derive(Default)]
    struct FakeInstall {
        steps: Vec<Step>,
    }

    impl Runner for FakeInstall {
        fn run(&mut self, step: &Step) -> Result<(), String> {
            self.steps.push(step.clone());
            let args: Vec<&str> = step.args.iter().map(|a| a.to_str().unwrap()).collect();
            match (step.program, args.as_slice()) {
                (INSTALL, ["-D", "-m", "0644", source, target]) => {
                    std::fs::create_dir_all(Path::new(target).parent().unwrap()).unwrap();
                    std::fs::copy(source, target).unwrap();
                    Ok(())
                }
                other => panic!("not the fixed step: {other:?}"),
            }
        }
    }

    /// SPEC-TRAY-SESSIONS TS6.
    #[test]
    fn shortcuts_are_rewritten_only_when_different() {
        let dir = tempfile::tempdir().unwrap();
        let autostart = dir.path().join("etc/xdg/autostart/bmuster-agent.desktop");
        let menu = dir
            .path()
            .join("usr/share/applications/bmuster-agent.desktop");
        let staged = dir.path().join("data/staged-shortcuts");
        let wanted = super::shortcuts();
        let entries: Vec<(PathBuf, String)> = vec![
            (autostart.clone(), wanted[0].1.clone()),
            (menu.clone(), wanted[1].1.clone()),
        ];
        // An install from 0.3.2: autostart starts the rescue copy, and the
        // menu entry is missing.
        std::fs::create_dir_all(autostart.parent().unwrap()).unwrap();
        std::fs::write(&autostart, "Exec=/opt/bmuster/bmuster-agent tray\n").unwrap();
        let mut runner = FakeInstall::default();
        assert_eq!(
            super::refresh_shortcuts(&entries, &staged, &mut runner).unwrap(),
            2
        );
        assert_eq!(std::fs::read_to_string(&autostart).unwrap(), wanted[0].1);
        assert_eq!(std::fs::read_to_string(&menu).unwrap(), wanted[1].1);
        assert_eq!(runner.steps.len(), 2, "only the fixed install step");
        assert!(!staged.exists(), "the staged copies are removed");

        // Identical files are left alone.
        let mut again = FakeInstall::default();
        assert_eq!(
            super::refresh_shortcuts(&entries, &staged, &mut again).unwrap(),
            0
        );
        assert!(again.steps.is_empty());

        // Only the changed file is rewritten.
        std::fs::write(&menu, "changed").unwrap();
        let mut once = FakeInstall::default();
        assert_eq!(
            super::refresh_shortcuts(&entries, &staged, &mut once).unwrap(),
            1
        );
        assert_eq!(Path::new(once.steps[0].args.last().unwrap()), menu);
    }

    /// SPEC-TRAY-SESSIONS TS7.
    #[test]
    fn one_helper_per_person() {
        let dir = tempfile::tempdir().unwrap();
        let first = super::single_instance(dir.path()).unwrap();
        assert!(first.is_some(), "the first helper takes the lock");
        assert!(
            super::single_instance(dir.path()).unwrap().is_none(),
            "a second helper does not"
        );
        drop(first);
        assert!(
            super::single_instance(dir.path()).unwrap().is_some(),
            "the lock frees when the first helper ends"
        );
        // A link in the runtime folder is never followed.
        let other = tempfile::tempdir().unwrap();
        let elsewhere = other.path().join("target");
        std::fs::write(&elsewhere, "").unwrap();
        let linked = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(&elsewhere, linked.path().join("bmuster-tray.lock")).unwrap();
        assert!(super::single_instance(linked.path()).is_err());
    }
}
