//! Listing, stat, new folder, rename and delete (SPEC-FILES F3, F7).
//!
//! Links are never followed when listing or deleting: `symlink_metadata`
//! describes the link itself, and deleting one removes the link, never what
//! it points at. A recursive delete walks the same way, so a link inside a
//! folder to somewhere else on the disk leaves that somewhere else alone.

use super::paths::{check_path, child, display, NameUse, HOST};
use super::{millis, FileError};
use bmuster_protocol::files::{
    Entry, EntryKind, ErrorCode, Failure, FilesResult, Stat, MAX_LIST_ENTRIES,
};
use std::fs::{self, Metadata};
use std::path::Path;

fn kind_of(metadata: &Metadata) -> EntryKind {
    let file_type = metadata.file_type();
    if file_type.is_symlink() {
        EntryKind::Link
    } else if file_type.is_dir() {
        EntryKind::Folder
    } else if file_type.is_file() {
        EntryKind::File
    } else {
        EntryKind::Other
    }
}

#[cfg(windows)]
fn is_hidden(_name: &str, metadata: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt as _;
    const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
    metadata.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0
}

#[cfg(not(windows))]
fn is_hidden(name: &str, _metadata: &Metadata) -> bool {
    name.starts_with('.')
}

/// One folder's entries, at most [`MAX_LIST_ENTRIES`], in the order the
/// file system gives them (the console sorts).
pub fn list(path: &str) -> Result<FilesResult, FileError> {
    let dir = check_path(HOST, path)?;
    let reader = fs::read_dir(&dir).map_err(|e| FileError::io(&e, path))?;
    let mut entries = Vec::new();
    let mut more = false;
    for item in reader {
        let Ok(item) = item else { continue };
        if entries.len() == MAX_LIST_ENTRIES {
            more = true;
            break;
        }
        let name = item.file_name().to_string_lossy().into_owned();
        let Ok(metadata) = fs::symlink_metadata(item.path()) else {
            continue;
        };
        let kind = kind_of(&metadata);
        let link_target = if kind == EntryKind::Link {
            fs::read_link(item.path())
                .ok()
                .map(|target| display(&target))
        } else {
            None
        };
        entries.push(Entry {
            hidden: is_hidden(&name, &metadata),
            name,
            kind,
            size: if kind == EntryKind::File {
                metadata.len()
            } else {
                0
            },
            modified_ms: millis(metadata.modified()),
            link_target,
        });
    }
    Ok(FilesResult::Listing {
        path: display(&dir),
        entries,
        more,
    })
}

/// What a download would read: links are followed here, to their target.
pub fn stat(path: &str) -> Result<FilesResult, FileError> {
    let file = check_path(HOST, path)?;
    let metadata = fs::metadata(&file).map_err(|e| FileError::io(&e, path))?;
    Ok(FilesResult::Stat(Stat {
        kind: kind_of(&metadata),
        size: metadata.len(),
        modified_ms: millis(metadata.modified()),
    }))
}

pub fn mkdir(dir: &str, name: &str) -> Result<FilesResult, FileError> {
    let path = child(HOST, dir, name, NameUse::New)?;
    fs::create_dir(&path).map_err(|e| FileError::io(&e, &display(&path)))?;
    Ok(FilesResult::Path {
        path: display(&path),
    })
}

/// Renames within one folder; never replaces something already there.
pub fn rename(dir: &str, from: &str, to: &str) -> Result<FilesResult, FileError> {
    let source = child(HOST, dir, from, NameUse::Existing)?;
    let target = child(HOST, dir, to, NameUse::New)?;
    fs::symlink_metadata(&source).map_err(|e| FileError::io(&e, &display(&source)))?;
    if fs::symlink_metadata(&target).is_ok() {
        return Err(FileError::new(
            ErrorCode::Exists,
            format!("{} already exists.", display(&target)),
        ));
    }
    fs::rename(&source, &target).map_err(|e| FileError::io(&e, &display(&source)))?;
    Ok(FilesResult::Path {
        path: display(&target),
    })
}

/// Removes a link itself (on Windows a link to a folder is removed as a folder).
fn remove_link(path: &Path) -> std::io::Result<()> {
    match fs::remove_file(path) {
        Err(e) if cfg!(windows) => fs::remove_dir(path).map_err(|_| e),
        other => other,
    }
}

/// Removes `path` and, for a folder, everything in it, without following
/// links. Returns how many things it removed.
fn remove_tree(path: &Path) -> std::io::Result<u64> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() {
        remove_link(path)?;
        return Ok(1);
    }
    if !metadata.is_dir() {
        fs::remove_file(path)?;
        return Ok(1);
    }
    let mut removed = 0;
    for item in fs::read_dir(path)? {
        removed += remove_tree(&item?.path())?;
    }
    fs::remove_dir(path)?;
    Ok(removed + 1)
}

/// Deletes each name in `dir`. Folders need `recursive` unless empty.
/// Each name succeeds or fails on its own.
pub fn delete(dir: &str, names: &[String], recursive: bool) -> Result<FilesResult, FileError> {
    check_path(HOST, dir)?;
    if names.is_empty() {
        return Err(FileError::invalid("Nothing was chosen to delete.".into()));
    }
    for name in names {
        child(HOST, dir, name, NameUse::Existing)?;
    }
    let mut removed = Vec::new();
    let mut failed = Vec::new();
    let mut items = 0;
    for name in names {
        let path = child(HOST, dir, name, NameUse::Existing)?;
        let outcome = fs::symlink_metadata(&path).and_then(|metadata| {
            if metadata.file_type().is_symlink() {
                remove_link(&path).map(|()| 1)
            } else if metadata.is_dir() {
                if recursive {
                    remove_tree(&path)
                } else {
                    fs::remove_dir(&path).map(|()| 1)
                }
            } else {
                fs::remove_file(&path).map(|()| 1)
            }
        });
        match outcome {
            Ok(count) => {
                items += count;
                removed.push(name.clone());
            }
            Err(e) => failed.push(Failure {
                name: name.clone(),
                message: FileError::io(&e, &display(&path)).message,
            }),
        }
    }
    Ok(FilesResult::Deleted {
        removed,
        items,
        failed,
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    fn text(path: &Path) -> String {
        display(path)
    }

    #[test]
    fn listing_describes_links_without_following_them() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a.txt"), b"hello").unwrap();
        fs::create_dir(dir.path().join("sub")).unwrap();
        fs::write(dir.path().join(".secret"), b"").unwrap();
        symlink(outside.path(), dir.path().join("elsewhere")).unwrap();
        let FilesResult::Listing { entries, more, .. } = list(&text(dir.path())).unwrap() else {
            panic!("not a listing")
        };
        assert!(!more);
        let find = |name: &str| entries.iter().find(|e| e.name == name).unwrap();
        assert_eq!(find("a.txt").kind, EntryKind::File);
        assert_eq!(find("a.txt").size, 5);
        assert!(find("a.txt").modified_ms.is_some());
        assert_eq!(find("sub").kind, EntryKind::Folder);
        assert!(find(".secret").hidden);
        let link = find("elsewhere");
        assert_eq!(link.kind, EntryKind::Link);
        assert_eq!(
            link.link_target.as_deref(),
            Some(text(outside.path()).as_str())
        );
    }

    #[test]
    fn listing_stops_at_the_cap() {
        let dir = tempfile::tempdir().unwrap();
        for index in 0..MAX_LIST_ENTRIES + 3 {
            fs::write(dir.path().join(format!("f{index}")), b"").unwrap();
        }
        let FilesResult::Listing { entries, more, .. } = list(&text(dir.path())).unwrap() else {
            panic!("not a listing")
        };
        assert_eq!(entries.len(), MAX_LIST_ENTRIES);
        assert!(more);
    }

    #[test]
    fn mkdir_and_rename_refuse_bad_names_and_clashes() {
        let dir = tempfile::tempdir().unwrap();
        let base = text(dir.path());
        mkdir(&base, "Reports").unwrap();
        assert!(dir.path().join("Reports").is_dir());
        assert_eq!(mkdir(&base, "Reports").unwrap_err().code, ErrorCode::Exists);
        assert_eq!(mkdir(&base, "../up").unwrap_err().code, ErrorCode::Invalid);
        fs::write(dir.path().join("a.txt"), b"a").unwrap();
        assert_eq!(
            rename(&base, "a.txt", "Reports").unwrap_err().code,
            ErrorCode::Exists
        );
        rename(&base, "a.txt", "b.txt").unwrap();
        assert!(dir.path().join("b.txt").is_file());
        assert_eq!(
            rename(&base, "missing", "c").unwrap_err().code,
            ErrorCode::NotFound
        );
        assert_eq!(
            rename(&base, "b.txt", "x:y").unwrap_err().code,
            ErrorCode::Invalid
        );
    }

    #[test]
    fn deleting_a_link_leaves_its_target() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let target = outside.path().join("keep.txt");
        fs::write(&target, b"keep me").unwrap();
        symlink(&target, dir.path().join("link-to-file")).unwrap();
        symlink(outside.path(), dir.path().join("link-to-folder")).unwrap();
        let FilesResult::Deleted {
            removed,
            items,
            failed,
        } = delete(
            &text(dir.path()),
            &["link-to-file".into(), "link-to-folder".into()],
            true,
        )
        .unwrap()
        else {
            panic!("not a delete")
        };
        assert_eq!(removed.len(), 2);
        assert_eq!(items, 2);
        assert!(failed.is_empty());
        assert_eq!(fs::read(&target).unwrap(), b"keep me");
        assert!(fs::symlink_metadata(dir.path().join("link-to-file")).is_err());
    }

    #[test]
    fn a_recursive_delete_does_not_walk_through_links() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("keep.txt"), b"keep").unwrap();
        let folder = dir.path().join("folder");
        fs::create_dir_all(folder.join("inner")).unwrap();
        fs::write(folder.join("inner/file"), b"x").unwrap();
        symlink(outside.path(), folder.join("inner/escape")).unwrap();
        let base = text(dir.path());
        let FilesResult::Deleted { failed, .. } = delete(&base, &["folder".into()], false).unwrap()
        else {
            panic!("not a delete")
        };
        assert_eq!(failed.len(), 1, "a full folder needs recursive");
        assert!(folder.exists());
        let FilesResult::Deleted { items, failed, .. } =
            delete(&base, &["folder".into()], true).unwrap()
        else {
            panic!("not a delete")
        };
        assert!(failed.is_empty(), "{failed:?}");
        assert_eq!(items, 4, "folder, inner, file and the link");
        assert!(!folder.exists());
        assert_eq!(fs::read(outside.path().join("keep.txt")).unwrap(), b"keep");
    }

    #[test]
    fn delete_checks_every_name_before_removing_any() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("a"), b"").unwrap();
        let error = delete(&text(dir.path()), &["a".into(), "../b".into()], false).unwrap_err();
        assert_eq!(error.code, ErrorCode::Invalid);
        assert!(dir.path().join("a").exists());
    }

    #[test]
    fn stat_follows_links_to_what_a_download_reads() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("real"), b"12345").unwrap();
        symlink(dir.path().join("real"), dir.path().join("alias")).unwrap();
        let FilesResult::Stat(stat) = stat(&text(&dir.path().join("alias"))).unwrap() else {
            panic!("not a stat")
        };
        assert_eq!(stat.kind, EntryKind::File);
        assert_eq!(stat.size, 5);
    }
}
