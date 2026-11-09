//! The rescue copy (SPEC-SERVER-UPDATES, agents): the installed binary in
//! `/opt/bmuster` (`C:\Program Files\BMuster` on Windows), kept only to roll
//! back. On Linux the service runs the current version's own binary as the
//! launcher, so the launcher updates with it; if that start fails three
//! times in five minutes, systemd runs `bmuster-agent rescue` from the copy
//! (on Windows, the service's recovery action), which puts `previous` back
//! as `current` and starts the agent again. The reason is recorded for the
//! next check-in.
//!
//! A version that has been healthy for 24 hours copies itself over the
//! rescue copy, so the copy is at most one version behind.

use crate::identity::write_private;
use crate::updates::{self, now_ms, Layout, Slot};
use anyhow::{bail, Context as _, Result};
use bmuster_protocol::UpdateEvent;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// How long a version must run healthily before it becomes the rescue copy.
pub const REFRESH_AFTER: Duration = Duration::from_secs(24 * 60 * 60);
/// Beside the update state (`updates::state_dir`): the rescue copy's version.
const RECORD_FILE: &str = "rescue-copy.json";

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    version: String,
}

/// The rescue copy's version, as last recorded; `None` before the first.
pub fn recorded_version(data_dir: &Path) -> Option<String> {
    let text = fs::read_to_string(record_path(data_dir)).ok()?;
    serde_json::from_str::<Record>(&text)
        .ok()
        .map(|record| record.version)
}

pub fn record_path(data_dir: &Path) -> PathBuf {
    updates::state_dir(data_dir).join(RECORD_FILE)
}

pub fn record_version(data_dir: &Path, version: &str) -> Result<()> {
    let json = serde_json::to_vec(&Record {
        version: version.to_string(),
    })?;
    let path = record_path(data_dir);
    if let Some(folder) = path.parent() {
        fs::create_dir_all(folder)
            .with_context(|| format!("could not create {}", folder.display()))?;
    }
    write_private(&path, &json)
}

/// What `rescue` did.
#[derive(Debug, PartialEq, Eq)]
pub enum Rescued {
    /// `previous` is `current` again.
    Previous { failed: String, running: String },
    /// There was no `previous`: the rescue copy itself is `current` now.
    RescueCopy { failed: String, running: String },
    /// `current` already is the rescue copy's version and there is nothing
    /// older to go back to; the service is left stopped.
    Nothing,
}

/// Rolls `current` back: to `previous` when there is one, else to the
/// rescue copy (`own_binary`, version `own_version`). Records the rollback.
pub fn roll_back(data_dir: &Path, own_binary: &Path, own_version: &str) -> Result<Rescued> {
    let layout = Layout::new(data_dir);
    layout.create_root()?;
    let failed = layout
        .release(Slot::Current)
        .map_or_else(|_| "(unknown)".to_string(), |release| release.version);
    layout.remove_incoming()?;
    layout.end_switch()?;
    let marker = layout.checked_in_marker();
    if marker.exists() {
        fs::remove_file(&marker)
            .with_context(|| format!("could not remove {}", marker.display()))?;
    }
    let from_previous = layout.binary(Slot::Previous).exists();
    let running = if from_previous {
        let running = layout.release(Slot::Previous)?.version;
        layout.restore_previous()?;
        running
    } else if failed != own_version {
        let bytes = fs::read(own_binary)
            .with_context(|| format!("could not read {}", own_binary.display()))?;
        updates::seed_current(&layout, &bytes, own_version)?;
        own_version.to_string()
    } else {
        return Ok(Rescued::Nothing);
    };
    let rescued = if from_previous {
        Rescued::Previous {
            failed: failed.clone(),
            running: running.clone(),
        }
    } else {
        Rescued::RescueCopy {
            failed: failed.clone(),
            running: running.clone(),
        }
    };
    updates::record_event(
        data_dir,
        UpdateEvent::RolledBack {
            version: failed.clone(),
            reason: format!(
                "the service failed to start {failed} three times in five minutes; the rescue \
                 copy went back to {running}"
            ),
            at_ms: now_ms(),
        },
    )?;
    Ok(rescued)
}

/// `bmuster-agent rescue`, run by the service manager from the rescue copy.
pub fn run() -> Result<()> {
    crate::platform::require_admin()?;
    let data_dir = crate::paths::default_data_dir()?;
    let own = std::env::current_exe().context("could not find this program's path")?;
    match roll_back(&data_dir, &own, updates::VERSION)? {
        Rescued::Nothing => {
            log::error!(
                "The agent keeps failing to start, and version {} (this rescue copy) is the \
                 oldest there is; the service stays stopped. Reinstall the agent.",
                updates::VERSION
            );
            Ok(())
        }
        Rescued::Previous { failed, running } | Rescued::RescueCopy { failed, running } => {
            log::warn!("Version {failed} failed to start; rolled back to {running}.");
            crate::platform::finish_rescue()
        }
    }
}

/// Whether a version that has run healthily for `healthy_for` should copy
/// itself over the rescue copy.
pub fn refresh_due(recorded: Option<&str>, running: &str, healthy_for: Duration) -> bool {
    healthy_for >= REFRESH_AFTER && recorded != Some(running)
}

/// Copies the current version's binary (`source`, which must be the binary
/// in `versions/current` and of `version`) over the rescue copy at
/// `rescue`, then records the version.
pub fn refresh(data_dir: &Path, source: &Path, rescue: &Path, version: &str) -> Result<()> {
    let layout = Layout::new(data_dir);
    let current = layout.binary(Slot::Current);
    if source.canonicalize().ok() != current.canonicalize().ok() {
        bail!(
            "only the binary in {} becomes the rescue copy, not {}",
            current.display(),
            source.display()
        );
    }
    let installed = layout.release(Slot::Current)?.version;
    if installed != version {
        bail!("the current version is {installed}, not {version}");
    }
    let staged = rescue.with_extension("new");
    fs::copy(source, &staged).with_context(|| {
        format!(
            "could not copy {} to {}",
            source.display(),
            staged.display()
        )
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(&staged, fs::Permissions::from_mode(0o755))?;
    }
    // Windows cannot replace a running program, but can rename it away.
    #[cfg(windows)]
    {
        let old = rescue.with_extension("old");
        let _ = fs::remove_file(&old);
        if rescue.exists() {
            fs::rename(rescue, &old)
                .with_context(|| format!("could not move {} aside", rescue.display()))?;
        }
    }
    fs::rename(&staged, rescue)
        .with_context(|| format!("could not move {} into place", rescue.display()))?;
    record_version(data_dir, version)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::updates::tests::{signed, test_key};

    /// `previous` (if given) and then `current`, as updates leave them.
    fn install(layout: &Layout, previous: Option<&str>, current: &str) {
        let release = |version: &str| {
            let bytes = format!("agent {version}").into_bytes();
            (signed(version, &bytes, &test_key()), bytes)
        };
        match previous {
            Some(previous) => {
                let (old, bytes) = release(previous);
                layout.seed_current(&old, &bytes).unwrap();
                let (new, bytes) = release(current);
                layout.store_incoming(&new, &bytes).unwrap();
                layout.promote(current).unwrap();
            }
            None => {
                let (new, bytes) = release(current);
                layout.seed_current(&new, &bytes).unwrap();
            }
        }
    }

    #[test]
    fn rescue_rolls_back() {
        // current 2.0.0 fails, previous 1.0.0 is put back.
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path());
        install(&layout, Some("1.0.0"), "2.0.0");
        let rescue = dir.path().join("rescue-copy");
        fs::write(&rescue, b"rescue").unwrap();
        assert_eq!(
            roll_back(dir.path(), &rescue, "1.0.0").unwrap(),
            Rescued::Previous {
                failed: "2.0.0".into(),
                running: "1.0.0".into()
            }
        );
        assert_eq!(layout.release(Slot::Current).unwrap().version, "1.0.0");
        assert!(!layout.binary(Slot::Previous).exists());
        match updates::last_event(dir.path()) {
            UpdateEvent::RolledBack {
                version, reason, ..
            } => {
                assert_eq!(version, "2.0.0");
                assert!(reason.contains("failed to start"), "{reason}");
            }
            other => panic!("expected a rollback, got {other:?}"),
        }

        // No previous: the rescue copy itself becomes current.
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path());
        install(&layout, None, "2.0.0");
        let rescue = dir.path().join("rescue-copy");
        fs::write(&rescue, b"rescue bytes").unwrap();
        assert!(matches!(
            roll_back(dir.path(), &rescue, "1.5.0").unwrap(),
            Rescued::RescueCopy { .. }
        ));
        let seeded = layout.release(Slot::Current).unwrap();
        assert_eq!(seeded.version, "1.5.0");
        assert_eq!(
            fs::read(layout.binary(Slot::Current)).unwrap(),
            b"rescue bytes"
        );

        // Already on the rescue copy's version with nothing older: left alone.
        assert_eq!(
            roll_back(dir.path(), &rescue, "1.5.0").unwrap(),
            Rescued::Nothing
        );
    }

    #[test]
    fn rescue_refresh() {
        let day = REFRESH_AFTER;
        assert!(!refresh_due(
            Some("1.0.0"),
            "2.0.0",
            day - Duration::from_secs(1)
        ));
        assert!(refresh_due(Some("1.0.0"), "2.0.0", day));
        assert!(refresh_due(None, "2.0.0", day));
        assert!(!refresh_due(Some("2.0.0"), "2.0.0", day * 2));

        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path());
        install(&layout, Some("1.0.0"), "2.0.0");
        let rescue = dir.path().join("bmuster-agent");
        fs::write(&rescue, b"agent 1.0.0").unwrap();

        // Only the current slot's binary, at its own version, may refresh it.
        let previous = layout.binary(Slot::Previous);
        assert!(refresh(dir.path(), &previous, &rescue, "1.0.0").is_err());
        let current = layout.binary(Slot::Current);
        assert!(refresh(dir.path(), &current, &rescue, "9.9.9").is_err());
        assert_eq!(fs::read(&rescue).unwrap(), b"agent 1.0.0");

        refresh(dir.path(), &current, &rescue, "2.0.0").unwrap();
        assert_eq!(fs::read(&rescue).unwrap(), b"agent 2.0.0");
        assert_eq!(recorded_version(dir.path()).as_deref(), Some("2.0.0"));
        use std::os::unix::fs::PermissionsExt as _;
        let mode = fs::metadata(&rescue).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o755);
    }
}
