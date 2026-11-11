//! `bmuster-agent storage-scan` (SPEC-STORAGE 3): one pass over every local
//! drive at the lowest priority, each drive's scan saved when it finishes.
//! Read-only on the drives: it lists folders and reads metadata, and writes
//! only under `<data>/storage/`. One pass at a time (an exclusive lock that
//! the system releases if the scanner dies).

use super::pace::{self, Pace, Speed};
use super::store::{self, Scan};
use super::walk::{self, Hooks};
use super::{load_state, save_state, Running, State, LOCK_FILE};
use anyhow::{Context as _, Result};
use bmuster_protocol::storage::{LastScan, StorageProblem};
use std::fs::{self, File, TryLockError};
use std::path::Path;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// How often the progress in `state.json` is rewritten at most.
const PROGRESS_EVERY: Duration = Duration::from_secs(10);

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|since| i64::try_from(since.as_millis()).ok())
        .unwrap_or(0)
}

/// Paces the walk and keeps the progress current.
struct Progress<'a> {
    pace: Pace,
    data_dir: &'a Path,
    state: &'a mut State,
    written: Instant,
}

impl Hooks for Progress<'_> {
    fn between_folders(&mut self, counted: u64) -> bool {
        self.pace.between_folders();
        if self.written.elapsed() >= PROGRESS_EVERY {
            if let Running::Scanning { counted: shown, .. } = &mut self.state.running {
                *shown = counted;
            }
            write_state(self.data_dir, self.state);
            self.written = Instant::now();
        }
        true
    }
}

/// Progress that cannot be written (a full disk) is logged, not fatal.
fn write_state(data_dir: &Path, state: &State) {
    if let Err(e) = save_state(data_dir, state) {
        log::warn!("Storage scan: could not save its progress: {e:#}");
    }
}

/// Removes temporary files a cut-off save left behind.
fn remove_leftovers(folder: &Path) {
    let Ok(entries) = fs::read_dir(folder) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_some_and(|extension| extension == "tmp") {
            let _ = fs::remove_file(path);
        }
    }
}

/// Scans `mount` and saves it; a failure to save is the pass's problem.
fn scan_drive(data_dir: &Path, mount: &str, speed: Speed, state: &mut State) {
    let Some((size, free)) = crate::files::roots::space(Path::new(mount)) else {
        log::warn!("Storage scan: could not read the size of {mount}; skipped.");
        return;
    };
    let started_at_ms = now_ms();
    state.running = Running::Scanning {
        mount: mount.to_string(),
        started_at_ms,
        counted: 0,
        used: size.saturating_sub(free),
    };
    write_state(data_dir, state);
    let mut progress = Progress {
        pace: Pace::new(speed),
        data_dir,
        state,
        written: Instant::now(),
    };
    let Some(walked) = walk::walk(Path::new(mount), &mut progress) else {
        return;
    };
    let finished_at_ms = now_ms();
    let used = crate::files::roots::space(Path::new(mount))
        .map_or(size.saturating_sub(free), |(size, free)| {
            size.saturating_sub(free)
        });
    let scan = Scan::new(
        mount.to_string(),
        started_at_ms,
        finished_at_ms,
        (size, used),
        walked,
    );
    let last = LastScan::Complete {
        started_at_ms,
        finished_at_ms,
        scanned_bytes: scan.root.bytes,
        used_bytes: used,
        files: scan.root.files,
        folders: scan.folders,
        denied: scan.denied,
    };
    match store::save(&super::scan_path(data_dir, mount), &scan) {
        Ok(()) => {
            log::info!(
                "Storage scan: {mount} done ({} folders, {} kept).",
                scan.folders,
                count_kept(&scan.root)
            );
            state.last.insert(mount.to_string(), last);
        }
        Err(e) => {
            log::warn!("Storage scan: could not save the scan of {mount}: {e:#}");
            state.problem = StorageProblem::Failed {
                message: format!("The scan of {mount} could not be saved: {e:#}"),
                at_ms: finished_at_ms,
            };
        }
    }
}

fn count_kept(folder: &walk::Folder) -> usize {
    1 + folder.children.iter().map(count_kept).sum::<usize>()
}

/// One pass over every drive. Returns at once if another pass holds the lock.
pub fn run(data_dir: &Path, speed: Speed) -> Result<()> {
    pace::lower_priority();
    let folder = super::dir(data_dir);
    crate::identity::prepare_data_dir(&folder)?;
    let lock = File::create(folder.join(LOCK_FILE))
        .with_context(|| format!("could not open the scan lock in {}", folder.display()))?;
    match lock.try_lock() {
        Ok(()) => {}
        Err(TryLockError::WouldBlock) => {
            log::info!("Storage scan: another pass is running.");
            return Ok(());
        }
        Err(TryLockError::Error(e)) => return Err(e).context("could not take the scan lock"),
    }
    remove_leftovers(&folder);
    let mut state = load_state(data_dir);
    state.problem = StorageProblem::None;
    for mount in crate::files::roots::scan_targets() {
        scan_drive(data_dir, &mount, speed, &mut state);
    }
    state.running = Running::Idle;
    write_state(data_dir, &state);
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn leftover_temporary_files_are_removed() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.tmp"), b"x").unwrap();
        fs::write(dir.path().join("a.scan"), b"x").unwrap();
        remove_leftovers(dir.path());
        assert!(!dir.path().join("a.tmp").exists());
        assert!(dir.path().join("a.scan").exists());
    }

    #[test]
    fn a_second_pass_does_not_start_while_one_holds_the_lock() {
        let dir = tempfile::tempdir().unwrap();
        let folder = super::super::dir(dir.path());
        fs::create_dir_all(&folder).unwrap();
        let held = File::create(folder.join(LOCK_FILE)).unwrap();
        held.lock().unwrap();
        // Returns at once without scanning anything.
        run(dir.path(), Speed::Asked).unwrap();
        assert_eq!(load_state(dir.path()), State::default());
    }
}
