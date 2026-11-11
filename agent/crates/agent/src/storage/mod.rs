//! Storage (`docs/specs/SPEC-STORAGE.md`): a slow background scan of each
//! local drive, kept on the machine, read live by people with `files`.
//!
//! - [`walk`] totals one drive's folders, folding small ones away.
//! - [`store`] keeps one drive's last complete scan in a compact file.
//! - [`scan`] is `bmuster-agent storage-scan`: one pass over every drive, at
//!   the lowest priority, paced and paused by [`pace`].
//! - [`schedule`] runs in the agent and starts a pass when one is due.
//! - [`query`] answers the `storage-*` requests of a files session.
//!
//! Everything lives in `<data>/storage/`: `<key>.scan` per drive,
//! `state.json` (the pass running now, each drive's last scan and the last
//! problem; written only by the scanner) and `rescan` (a pass is wanted now).

pub mod pace;
pub mod query;
pub mod scan;
pub mod schedule;
pub mod store;
pub mod walk;

use anyhow::{Context as _, Result};
use bmuster_protocol::storage::{DriveSummary, LastScan, Scanning, StorageProblem, StorageReport};
use serde::{Deserialize, Serialize};
use sha2::{Digest as _, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// The folder under the data folder.
pub const DIR: &str = "storage";
const STATE_FILE: &str = "state.json";
const RESCAN_FILE: &str = "rescan";
const LOCK_FILE: &str = "scan.lock";

pub fn dir(data_dir: &Path) -> PathBuf {
    data_dir.join(DIR)
}

/// `<data>/storage/<key>.scan`: the key is the start of the SHA-256 of the
/// mount path, so any mount makes a safe file name.
pub fn scan_path(data_dir: &Path, mount: &str) -> PathBuf {
    let hash = hex::encode(Sha256::digest(mount.as_bytes()));
    dir(data_dir).join(format!("{}.scan", &hash[..16]))
}

/// The pass running now, as the scanner last wrote it.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum Running {
    #[default]
    Idle,
    #[serde(rename_all = "camelCase")]
    Scanning {
        mount: String,
        started_at_ms: i64,
        counted: u64,
        used: u64,
    },
}

/// `state.json`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct State {
    pub running: Running,
    /// Each drive's last complete scan, by mount.
    pub last: BTreeMap<String, LastScan>,
    pub problem: StorageProblem,
}

/// The state; empty when there is none yet. A damaged file is logged and
/// read as empty (the scanner writes a whole new one at its next step).
pub fn load_state(data_dir: &Path) -> State {
    let path = dir(data_dir).join(STATE_FILE);
    match std::fs::read(&path) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|e| {
            log::warn!("Storage: {} is unreadable ({e}).", path.display());
            State::default()
        }),
        Err(_) => State::default(),
    }
}

pub fn save_state(data_dir: &Path, state: &State) -> Result<()> {
    let bytes = serde_json::to_vec(state)?;
    crate::identity::write_private(&dir(data_dir).join(STATE_FILE), &bytes)
}

/// Asks for a pass now.
pub fn request_rescan(data_dir: &Path) -> Result<()> {
    let folder = dir(data_dir);
    crate::identity::prepare_data_dir(&folder)?;
    std::fs::write(folder.join(RESCAN_FILE), b"")
        .with_context(|| format!("could not ask for a scan in {}", folder.display()))
}

pub fn rescan_requested(data_dir: &Path) -> bool {
    dir(data_dir).join(RESCAN_FILE).exists()
}

/// The scheduler took the request.
pub fn clear_rescan(data_dir: &Path) {
    let _ = std::fs::remove_file(dir(data_dir).join(RESCAN_FILE));
}

/// Counted bytes against used bytes, 0 to 99 while running.
pub fn percent(counted: u64, used: u64) -> u8 {
    if used == 0 {
        return 0;
    }
    let share = u128::from(counted) * 100 / u128::from(used);
    u8::try_from(share.min(99)).unwrap_or(99)
}

/// One drive's summary from `state` and its live size and free space.
pub fn drive_summary(mount: &str, space: (u64, u64), state: &State) -> DriveSummary {
    let scanning = match &state.running {
        Running::Scanning {
            mount: running,
            started_at_ms,
            counted,
            used,
        } if running == mount => Scanning::Running {
            started_at_ms: *started_at_ms,
            percent: percent(*counted, *used),
        },
        _ => Scanning::Idle,
    };
    DriveSummary {
        mount: mount.to_string(),
        size_bytes: space.0,
        free_bytes: space.1,
        last_scan: state.last.get(mount).cloned().unwrap_or(LastScan::None),
        scanning,
    }
}

/// Whether a pass holds the scan lock now. A pass that was killed leaves
/// `state.json` saying it runs; the system released its lock, so this says
/// it does not.
pub fn pass_running(data_dir: &Path) -> bool {
    let Ok(lock) = std::fs::File::open(dir(data_dir).join(LOCK_FILE)) else {
        return false;
    };
    matches!(lock.try_lock(), Err(std::fs::TryLockError::WouldBlock))
}

/// Every scanned drive now, with its scan state.
pub fn drives(data_dir: &Path) -> Vec<DriveSummary> {
    let mut state = load_state(data_dir);
    if !pass_running(data_dir) {
        state.running = Running::Idle;
    }
    crate::files::roots::scan_targets()
        .into_iter()
        .filter_map(|mount| {
            let space = crate::files::roots::space(Path::new(&mount))?;
            Some(drive_summary(&mount, space, &state))
        })
        .collect()
}

/// The check-in's `storage` (SPEC-STORAGE 6).
pub fn report(data_dir: &Path) -> StorageReport {
    StorageReport::Reported {
        drives: drives(data_dir),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_stays_below_100_while_running() {
        assert_eq!(percent(0, 0), 0);
        assert_eq!(percent(50, 100), 50);
        assert_eq!(percent(150, 100), 99);
    }

    #[test]
    fn a_drive_shows_its_last_scan_and_whether_it_is_being_scanned() {
        let mut state = State {
            running: Running::Scanning {
                mount: "/home".into(),
                started_at_ms: 7,
                counted: 25,
                used: 100,
            },
            ..State::default()
        };
        state.last.insert(
            "/".into(),
            LastScan::Complete {
                started_at_ms: 1,
                finished_at_ms: 2,
                scanned_bytes: 3,
                used_bytes: 4,
                files: 5,
                folders: 6,
                denied: 0,
            },
        );
        let root = drive_summary("/", (100, 40), &state);
        assert!(matches!(root.last_scan, LastScan::Complete { .. }));
        assert_eq!(root.scanning, Scanning::Idle);
        let home = drive_summary("/home", (100, 40), &state);
        assert_eq!(home.last_scan, LastScan::None);
        assert_eq!(
            home.scanning,
            Scanning::Running {
                started_at_ms: 7,
                percent: 25
            }
        );
    }

    #[test]
    fn a_pass_runs_only_while_it_holds_the_lock() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!pass_running(dir.path()));
        std::fs::create_dir_all(super::dir(dir.path())).unwrap();
        let held = std::fs::File::create(super::dir(dir.path()).join(LOCK_FILE)).unwrap();
        assert!(!pass_running(dir.path()), "a lock file nobody holds");
        held.lock().unwrap();
        assert!(pass_running(dir.path()));
        drop(held);
        assert!(!pass_running(dir.path()), "released when the scanner dies");
    }

    #[test]
    fn state_and_rescan_requests_live_in_the_storage_folder() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(load_state(dir.path()), State::default());
        assert!(!rescan_requested(dir.path()));
        request_rescan(dir.path()).unwrap();
        assert!(rescan_requested(dir.path()));
        clear_rescan(dir.path());
        assert!(!rescan_requested(dir.path()));
        let state = State {
            problem: StorageProblem::Failed {
                message: "full".into(),
                at_ms: 3,
            },
            ..State::default()
        };
        save_state(dir.path(), &state).unwrap();
        assert_eq!(load_state(dir.path()), state);
        let a = scan_path(dir.path(), "/");
        assert_ne!(a, scan_path(dir.path(), "/home"));
        assert!(a.starts_with(dir.path().join(DIR)));
    }
}
