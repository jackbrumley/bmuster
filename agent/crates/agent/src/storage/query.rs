//! The `storage-*` requests of a files session (SPEC-STORAGE 5). They read
//! the last complete scans; nothing walks the disk on request. Paths follow
//! the Files rules ([`crate::files::paths`]).

use super::store::{self, Scan};
use super::walk::Folder;
use crate::files::paths::{check_path, HOST};
use crate::files::FileError;
use bmuster_protocol::files::{ErrorCode, FilesResult};
use bmuster_protocol::storage::{FolderChild, FolderView, LargeFile, FOLDER_PAGE, LARGEST_PAGE};
use std::path::Path;

/// The separator of this machine's paths.
const SEPARATOR: char = if cfg!(windows) { '\\' } else { '/' };

/// `parent` and `name` joined as the scan names folders.
pub fn join(parent: &str, name: &str) -> String {
    if parent.ends_with(['/', '\\']) {
        format!("{parent}{name}")
    } else {
        format!("{parent}{SEPARATOR}{name}")
    }
}

fn not_scanned(what: &str) -> FileError {
    FileError::new(ErrorCode::NotFound, what.to_string())
}

fn scan_of(data_dir: &Path, mount: &str) -> Result<Scan, FileError> {
    check_path(HOST, mount)?;
    match store::load(&super::scan_path(data_dir, mount)) {
        Ok(Some(scan)) if scan.mount == mount => Ok(scan),
        Ok(_) => Err(not_scanned("This drive has not been scanned yet.")),
        Err(e) => {
            log::warn!("Storage: {e:#}");
            Err(not_scanned("This drive's last scan could not be read."))
        }
    }
}

/// The parts of `path` below `mount`, or `None` when it is not on it.
fn parts_below<'a>(mount: &str, path: &'a str) -> Option<Vec<&'a str>> {
    let rest = path.strip_prefix(mount)?;
    if !mount.ends_with(['/', '\\']) && !rest.is_empty() && !rest.starts_with(['/', '\\']) {
        return None;
    }
    Some(
        rest.split(['/', '\\'])
            .filter(|part| !part.is_empty())
            .collect(),
    )
}

fn find<'a>(root: &'a Folder, parts: &[&str]) -> Option<&'a Folder> {
    parts.iter().try_fold(root, |folder, part| {
        folder.children.iter().find(|child| child.name == *part)
    })
}

/// One scanned folder of the drive at `mount`, sub-folders from `offset`.
pub fn folder(
    data_dir: &Path,
    mount: &str,
    path: &str,
    offset: u64,
) -> Result<FilesResult, FileError> {
    check_path(HOST, path)?;
    let scan = scan_of(data_dir, mount)?;
    let parts = parts_below(mount, path)
        .ok_or_else(|| FileError::invalid(format!("“{path}” is not on {mount}.")))?;
    let found = find(&scan.root, &parts).ok_or_else(|| {
        not_scanned("The last scan has no separate total for this folder (it is small, or new).")
    })?;
    let start = usize::try_from(offset).unwrap_or(usize::MAX);
    let children: Vec<FolderChild> = found
        .children
        .iter()
        .skip(start)
        .take(FOLDER_PAGE)
        .map(|child| FolderChild {
            name: child.name.clone(),
            path: join(path, &child.name),
            bytes: child.bytes,
            files: child.files,
            has_children: !child.children.is_empty(),
        })
        .collect();
    let more = found.children.len() > start.saturating_add(children.len());
    let not_scanned_bytes = if parts.is_empty() {
        scan.used_bytes.saturating_sub(scan.root.bytes)
    } else {
        0
    };
    Ok(FilesResult::StorageFolder(FolderView {
        mount: mount.to_string(),
        path: path.to_string(),
        finished_at_ms: scan.finished_at_ms,
        bytes: found.bytes,
        files: found.files,
        own_bytes: found.own_bytes,
        own_files: found.own_files,
        folded_folders: found.folded_folders,
        folded_bytes: found.folded_bytes,
        not_scanned_bytes,
        children,
        offset,
        more,
    }))
}

/// The largest files under `path` from the drive's last scan.
pub fn largest(data_dir: &Path, mount: &str, path: &str) -> Result<FilesResult, FileError> {
    check_path(HOST, path)?;
    let scan = scan_of(data_dir, mount)?;
    if parts_below(mount, path).is_none() {
        return Err(FileError::invalid(format!("“{path}” is not on {mount}.")));
    }
    let files = scan
        .largest
        .into_iter()
        .filter(|file| parts_below(path, &file.path).is_some_and(|parts| !parts.is_empty()))
        .take(LARGEST_PAGE)
        .map(|file| LargeFile {
            path: file.path,
            bytes: file.bytes,
            modified_ms: file.modified_ms,
        })
        .collect();
    Ok(FilesResult::StorageLargest { files })
}

/// Every scanned drive, its scan state and the last problem.
pub fn summary(data_dir: &Path) -> FilesResult {
    FilesResult::StorageSummary {
        drives: super::drives(data_dir),
        problem: super::load_state(data_dir).problem,
    }
}

/// Asks the scheduler for a pass now.
pub fn rescan(data_dir: &Path) -> Result<FilesResult, FileError> {
    super::request_rescan(data_dir).map_err(|e| FileError::new(ErrorCode::Io, format!("{e:#}")))?;
    Ok(FilesResult::Nothing {})
}

#[cfg(all(test, unix))]
mod tests {
    use super::super::store::tests::sample;
    use super::*;

    fn saved() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(super::super::dir(dir.path())).unwrap();
        store::save(&super::super::scan_path(dir.path(), "/"), &sample()).unwrap();
        dir
    }

    fn view(result: FilesResult) -> FolderView {
        match result {
            FilesResult::StorageFolder(view) => view,
            other => panic!("not a folder: {other:?}"),
        }
    }

    #[test]
    fn s5_a_folder_lists_its_children_biggest_first_with_what_was_not_scanned() {
        let dir = saved();
        let root = view(folder(dir.path(), "/", "/", 0).unwrap());
        let names: Vec<&str> = root
            .children
            .iter()
            .map(|child| child.name.as_str())
            .collect();
        assert_eq!(names, ["var", "home"]);
        assert_eq!(root.children[0].path, "/var");
        assert!(root.children[0].has_children);
        assert_eq!(root.not_scanned_bytes, 500, "1,500 used, 1,000 counted");
        assert!(!root.more);
        let var = view(folder(dir.path(), "/", "/var", 0).unwrap());
        assert_eq!((var.folded_folders, var.folded_bytes), (2, 50));
        assert_eq!(var.not_scanned_bytes, 0);
        assert_eq!(var.children[0].path, "/var/log");
    }

    #[test]
    fn s5_pages_start_at_the_offset() {
        let dir = saved();
        let page = view(folder(dir.path(), "/", "/", 1).unwrap());
        assert_eq!(page.children.len(), 1);
        assert_eq!(page.children[0].name, "home");
        assert_eq!(page.offset, 1);
    }

    #[test]
    fn s5_unknown_relative_and_unscanned_paths_are_refused() {
        let dir = saved();
        let missing = folder(dir.path(), "/", "/var/tmp", 0).unwrap_err();
        assert_eq!(missing.code, ErrorCode::NotFound);
        let relative = folder(dir.path(), "/", "var", 0).unwrap_err();
        assert_eq!(relative.code, ErrorCode::Invalid);
        let unscanned = folder(dir.path(), "/home", "/home", 0).unwrap_err();
        assert_eq!(unscanned.code, ErrorCode::NotFound);
        let elsewhere = folder(dir.path(), "/var", "/variable", 0).unwrap_err();
        assert_eq!(
            elsewhere.code,
            ErrorCode::NotFound,
            "/var was never scanned"
        );
        assert_eq!(parts_below("/var", "/variable"), None);
    }

    #[test]
    fn s5_largest_files_are_filtered_to_the_folder() {
        let dir = saved();
        let FilesResult::StorageLargest { files } = largest(dir.path(), "/", "/var").unwrap()
        else {
            panic!("not largest files");
        };
        let paths: Vec<&str> = files.iter().map(|file| file.path.as_str()).collect();
        assert_eq!(paths, ["/var/log/syslog"]);
        let FilesResult::StorageLargest { files } = largest(dir.path(), "/", "/").unwrap() else {
            panic!("not largest files");
        };
        assert_eq!(files.len(), 2);
    }

    #[test]
    fn rescan_asks_for_a_pass() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(rescan(dir.path()).unwrap(), FilesResult::Nothing {});
        assert!(super::super::rescan_requested(dir.path()));
    }
}
