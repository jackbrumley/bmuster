//! Storage clean-up (SPEC-STORAGE 11): a fixed per-system list of
//! known-safe items, named by id only.
//!
//! - [`items`] says what each id is on this machine: its folders, rules and
//!   tools. Nothing else can be deleted this way.
//! - [`sweep`] sizes and deletes the files of an item's folders, never
//!   through a link; [`safe`] binds each delete to the folder it listed.
//! - The files session sizes items ([`sizes`]) and asks for a clean-up
//!   ([`start`]); the agent starts `bmuster-agent storage-clean`
//!   ([`launch`]), which runs it ([`run`]) and keeps `cleanup.json` current
//!   for [`status`] and the check-in.
//!
//! Files in `<data>/storage/`: `cleanup.json` (the last run),
//! `cleanup-wanted` (a run waiting to start: its id) and `cleanup.lock`
//! (held by the cleaner while it runs).

pub mod items;
pub mod launch;
pub mod safe;
pub mod sweep;

use crate::files::FileError;
use anyhow::{bail, Context as _, Result};
use bmuster_protocol::cleanup::{
    valid_run_id, CleanupItem, CleanupRun, ItemProgress, ItemResult, ItemSize, ItemState, Measured,
    CLEANUP_ITEMS,
};
use bmuster_protocol::files::{ErrorCode, FilesResult};
use items::Machine;
use std::fs::{self, File, OpenOptions, TryLockError};
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

const RUN_FILE: &str = "cleanup.json";
const WANTED_FILE: &str = "cleanup-wanted";
const LOCK_FILE: &str = "cleanup.lock";
/// How often progress is written at most.
const PROGRESS_EVERY: Duration = Duration::from_secs(2);

fn path(data_dir: &Path, name: &str) -> PathBuf {
    super::dir(data_dir).join(name)
}

/// What every offered item would free now (read only).
pub fn sizes() -> FilesResult {
    let now = SystemTime::now();
    let items = Machine::this().map_or_else(Vec::new, |machine| {
        CLEANUP_ITEMS
            .iter()
            .filter_map(|&id| {
                let plan = items::plan(&machine, id)?;
                Some(ItemSize {
                    id,
                    size: items::size(&plan, now),
                })
            })
            .collect()
    });
    FilesResult::StorageCleanupSizes { items }
}

/// Whether the cleaner holds its lock now.
pub fn cleaner_running(data_dir: &Path) -> bool {
    let Ok(lock) = File::open(path(data_dir, LOCK_FILE)) else {
        return false;
    };
    matches!(lock.try_lock(), Err(TryLockError::WouldBlock))
}

/// The run id waiting to start, if one is.
fn wanted(data_dir: &Path) -> Option<String> {
    fs::read_to_string(path(data_dir, WANTED_FILE)).ok()
}

pub fn load_run(data_dir: &Path) -> CleanupRun {
    match fs::read(path(data_dir, RUN_FILE)) {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|e| {
            log::warn!("Storage clean-up: {RUN_FILE} is unreadable ({e}).");
            CleanupRun::None
        }),
        Err(_) => CleanupRun::None,
    }
}

fn save_run(data_dir: &Path, run: &CleanupRun) -> Result<()> {
    crate::identity::write_private(&path(data_dir, RUN_FILE), &serde_json::to_vec(run)?)
}

/// Checks a start request against this machine: ids it offers, no
/// repeats, at least one.
fn check_items(machine: Option<&Machine>, items: &[CleanupItem]) -> Result<(), FileError> {
    if items.is_empty() {
        return Err(FileError::invalid(
            "Tick at least one item to clean up.".into(),
        ));
    }
    let mut seen = Vec::with_capacity(items.len());
    for item in items {
        if seen.contains(item) {
            return Err(FileError::invalid("An item is listed twice.".into()));
        }
        seen.push(*item);
        if machine
            .and_then(|machine| items::plan(machine, *item))
            .is_none()
        {
            return Err(FileError::invalid(
                "An item does not apply to this machine.".into(),
            ));
        }
    }
    Ok(())
}

fn busy() -> FileError {
    FileError::new(
        ErrorCode::Busy,
        "A clean-up is already running on this machine.".into(),
    )
}

/// Asks for a clean-up of `items`; the agent starts it within seconds.
pub fn start(
    data_dir: &Path,
    run_id: &str,
    items: &[CleanupItem],
) -> Result<FilesResult, FileError> {
    start_on(data_dir, Machine::this().as_ref(), run_id, items, now_ms())
}

fn start_on(
    data_dir: &Path,
    machine: Option<&Machine>,
    run_id: &str,
    items: &[CleanupItem],
    now_ms: i64,
) -> Result<FilesResult, FileError> {
    if !valid_run_id(run_id) {
        return Err(FileError::invalid("That is not a clean-up id.".into()));
    }
    check_items(machine, items)?;
    if cleaner_running(data_dir) {
        return Err(busy());
    }
    let io = |e: &dyn std::fmt::Display| FileError::new(ErrorCode::Io, format!("{e:#}"));
    crate::identity::prepare_data_dir(&super::dir(data_dir)).map_err(|e| io(&e))?;
    // Made create-new: of two starts at once, one wins.
    let mut claim = match OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path(data_dir, WANTED_FILE))
    {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => return Err(busy()),
        Err(e) => return Err(io(&e)),
    };
    let run = CleanupRun::Running {
        run_id: run_id.to_string(),
        started_at_ms: now_ms,
        items: items
            .iter()
            .map(|&id| ItemProgress {
                id,
                state: ItemState::Waiting,
            })
            .collect(),
    };
    let saved = save_run(data_dir, &run)
        .map_err(|e| io(&e))
        .and_then(|()| claim.write_all(run_id.as_bytes()).map_err(|e| io(&e)));
    if let Err(e) = saved {
        let _ = fs::remove_file(path(data_dir, WANTED_FILE));
        return Err(e);
    }
    log::info!("Storage clean-up {run_id} asked for: {items:?}.");
    Ok(FilesResult::Nothing {})
}

/// The last run as the console sees it: a run that says it is running but
/// neither holds the lock nor waits to start was cut off.
pub fn status(data_dir: &Path) -> CleanupRun {
    match load_run(data_dir) {
        CleanupRun::Running {
            run_id,
            started_at_ms,
            items,
        } if !cleaner_running(data_dir) && wanted(data_dir).as_deref() != Some(run_id.as_str()) => {
            CleanupRun::Interrupted {
                run_id,
                started_at_ms,
                items,
            }
        }
        run => run,
    }
}

pub fn now_ms() -> i64 {
    super::scan::now_ms()
}

fn result_without(message: String) -> ItemResult {
    ItemResult {
        freed_bytes: 0,
        measured: Measured::Counted,
        files_removed: 0,
        files_skipped: 0,
        errors: 1,
        messages: vec![message],
    }
}

/// `bmuster-agent storage-clean`: runs the waiting clean-up, one item at a
/// time, keeping `cleanup.json` current. One at a time (the lock).
pub fn run(data_dir: &Path) -> Result<()> {
    run_on(data_dir, Machine::this().as_ref())
}

fn run_on(data_dir: &Path, machine: Option<&Machine>) -> Result<()> {
    let lock =
        File::create(path(data_dir, LOCK_FILE)).context("could not open the clean-up lock")?;
    match lock.try_lock() {
        Ok(()) => {}
        Err(TryLockError::WouldBlock) => bail!("a clean-up is already running"),
        Err(TryLockError::Error(e)) => return Err(e).context("could not take the clean-up lock"),
    }
    let Some(run_id) = wanted(data_dir).filter(|id| !id.is_empty()) else {
        bail!("no clean-up is waiting");
    };
    let CleanupRun::Running {
        run_id: listed,
        started_at_ms,
        mut items,
    } = load_run(data_dir)
    else {
        bail!("the waiting clean-up has no run");
    };
    if listed != run_id {
        bail!("the waiting clean-up {run_id} is not the run {listed}");
    }
    fs::remove_file(path(data_dir, WANTED_FILE)).context("could not take the request")?;
    log::info!("Storage clean-up {run_id} started.");
    for index in 0..items.len() {
        let id = items[index].id;
        let plan = machine.and_then(|machine| items::plan(machine, id));
        items[index].state = ItemState::Running {
            freed_bytes: 0,
            files_removed: 0,
        };
        write(data_dir, &run_id, started_at_ms, &items, None);
        let result = match plan {
            None => result_without("This item no longer applies to the machine.".into()),
            Some(plan) => {
                let mut written = Instant::now();
                let mut progress = |outcome: &sweep::Outcome| {
                    if written.elapsed() >= PROGRESS_EVERY {
                        items[index].state = ItemState::Running {
                            freed_bytes: outcome.freed_bytes,
                            files_removed: outcome.removed,
                        };
                        write(data_dir, &run_id, started_at_ms, &items, None);
                        written = Instant::now();
                    }
                };
                items::clean(&plan, SystemTime::now(), &mut progress)
            }
        };
        log::info!(
            "Storage clean-up {run_id}: {id:?} freed {} bytes, removed {}, skipped {}, {} errors.",
            result.freed_bytes,
            result.files_removed,
            result.files_skipped,
            result.errors
        );
        items[index].state = ItemState::Done { result };
    }
    write(data_dir, &run_id, started_at_ms, &items, Some(now_ms()));
    log::info!("Storage clean-up {run_id} finished.");
    drop(lock);
    Ok(())
}

/// Saves the run; a failure (a full disk) is logged, not fatal.
fn write(
    data_dir: &Path,
    run_id: &str,
    started_at_ms: i64,
    items: &[ItemProgress],
    finished: Option<i64>,
) {
    let run = match finished {
        None => CleanupRun::Running {
            run_id: run_id.to_string(),
            started_at_ms,
            items: items.to_vec(),
        },
        Some(finished_at_ms) => CleanupRun::Finished {
            run_id: run_id.to_string(),
            started_at_ms,
            finished_at_ms,
            items: items.to_vec(),
        },
    };
    if let Err(e) = save_run(data_dir, &run) {
        log::warn!("Storage clean-up: could not save its progress: {e:#}");
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::items::LinuxFolders;
    use super::*;

    const RUN: &str = "0f8fad5b-d9cb-469f-a165-70867728950e";
    const OTHER: &str = "1f8fad5b-d9cb-469f-a165-70867728950e";

    fn machine(root: &Path) -> Machine {
        Machine::Linux(LinuxFolders {
            root: root.to_path_buf(),
        })
    }

    fn setup() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let base = fs::canonicalize(dir.path()).unwrap();
        let data = base.join("data");
        let root = base.join("machine");
        fs::create_dir_all(root.join("var/crash")).unwrap();
        fs::write(root.join("var/crash/a.crash"), vec![1u8; 5000]).unwrap();
        fs::create_dir_all(root.join("var/tmp")).unwrap();
        (dir, data, root)
    }

    #[test]
    fn s17_a_start_names_offered_items_once() {
        let (_dir, data, root) = setup();
        let m = machine(&root);
        let start = |run: &str, items: &[CleanupItem]| start_on(&data, Some(&m), run, items, 1);
        let code = |result: Result<FilesResult, FileError>| result.unwrap_err().code;
        assert_eq!(code(start(RUN, &[])), ErrorCode::Invalid);
        assert_eq!(
            code(start(
                RUN,
                &[CleanupItem::LinuxCrashDumps, CleanupItem::LinuxCrashDumps]
            )),
            ErrorCode::Invalid
        );
        assert_eq!(
            code(start(RUN, &[CleanupItem::RecycleBins])),
            ErrorCode::Invalid
        );
        assert_eq!(
            code(start(RUN, &[CleanupItem::Journal])),
            ErrorCode::Invalid,
            "no journalctl"
        );
        assert_eq!(
            code(start("../x", &[CleanupItem::LinuxCrashDumps])),
            ErrorCode::Invalid
        );
        assert_eq!(
            code(start_on(
                &data,
                None,
                RUN,
                &[CleanupItem::LinuxCrashDumps],
                1
            )),
            ErrorCode::Invalid,
            "no clean-up on this system"
        );
        assert!(
            !data.join("storage").join(WANTED_FILE).exists(),
            "nothing asked for"
        );

        assert_eq!(
            start(RUN, &[CleanupItem::LinuxCrashDumps]).unwrap(),
            FilesResult::Nothing {}
        );
        assert_eq!(
            code(start(OTHER, &[CleanupItem::OldVarTmp])),
            ErrorCode::Busy,
            "one waits"
        );
        let CleanupRun::Running { run_id, items, .. } = status(&data) else {
            panic!("not waiting");
        };
        assert_eq!(run_id, RUN);
        assert_eq!(items[0].state, ItemState::Waiting);
    }

    #[test]
    fn s18_the_cleaner_runs_every_item_and_finishes() {
        let (_dir, data, root) = setup();
        let m = machine(&root);
        start_on(
            &data,
            Some(&m),
            RUN,
            &[CleanupItem::LinuxCrashDumps, CleanupItem::OldVarTmp],
            7,
        )
        .unwrap();
        run_on(&data, Some(&m)).unwrap();
        let CleanupRun::Finished {
            run_id,
            started_at_ms,
            items,
            ..
        } = status(&data)
        else {
            panic!("not finished: {:?}", status(&data));
        };
        assert_eq!((run_id.as_str(), started_at_ms), (RUN, 7));
        let ItemState::Done { result } = &items[0].state else {
            panic!("not done");
        };
        assert_eq!(result.files_removed, 1);
        assert!(result.freed_bytes >= 5000);
        assert!(!root.join("var/crash/a.crash").exists());
        assert!(matches!(items[1].state, ItemState::Done { .. }));
        assert!(!data.join("storage").join(WANTED_FILE).exists());
        assert!(run_on(&data, Some(&m)).is_err(), "nothing waits now");
        // The lock is an flock on an open file description. Another test in
        // this process forking a child at that moment shares the description
        // until the child's exec closes it, so the lock can look held for a
        // moment after run_on let go. Wait for that, as a real start would.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while cleaner_running(&data) && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        start_on(&data, Some(&m), OTHER, &[CleanupItem::OldVarTmp], 9).unwrap();
    }

    #[test]
    fn s18_a_run_cut_off_reads_as_interrupted_and_one_runs_at_a_time() {
        let (_dir, data, root) = setup();
        let m = machine(&root);
        start_on(&data, Some(&m), RUN, &[CleanupItem::LinuxCrashDumps], 1).unwrap();
        // The cleaner took the request and died.
        fs::remove_file(data.join("storage").join(WANTED_FILE)).unwrap();
        assert!(matches!(status(&data), CleanupRun::Interrupted { .. }));
        // While a cleaner holds the lock, it is running and a new start is busy.
        let held = File::create(data.join("storage").join(LOCK_FILE)).unwrap();
        held.lock().unwrap();
        assert!(cleaner_running(&data));
        assert!(matches!(status(&data), CleanupRun::Running { .. }));
        assert_eq!(
            start_on(&data, Some(&m), OTHER, &[CleanupItem::LinuxCrashDumps], 2)
                .unwrap_err()
                .code,
            ErrorCode::Busy
        );
        assert!(
            run_on(&data, Some(&m)).is_err(),
            "a second cleaner gives way"
        );
        drop(held);
        assert_eq!(
            load_run(&tempfile::tempdir().unwrap().path().join("none")),
            CleanupRun::None
        );
    }

    #[test]
    fn s18_an_item_that_no_longer_applies_is_an_error_not_a_stop() {
        let (_dir, data, root) = setup();
        let m = machine(&root);
        start_on(
            &data,
            Some(&m),
            RUN,
            &[CleanupItem::OldVarTmp, CleanupItem::LinuxCrashDumps],
            1,
        )
        .unwrap();
        fs::remove_dir(root.join("var/tmp")).unwrap();
        run_on(&data, Some(&m)).unwrap();
        let CleanupRun::Finished { items, .. } = status(&data) else {
            panic!("not finished");
        };
        let ItemState::Done { result } = &items[0].state else {
            panic!("not done");
        };
        assert_eq!(result.errors, 1);
        assert!(matches!(&items[1].state, ItemState::Done { result } if result.files_removed == 1));
    }
}
