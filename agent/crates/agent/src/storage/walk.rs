//! The walk (SPEC-STORAGE 3.3, 4): one drive's folders totalled, small
//! folders folded into their parents, and the largest files kept.
//!
//! - Never follows links: a symbolic link, junction or other reparse point
//!   counts as itself and is not walked.
//! - Stays on its drive: a folder on another device (Linux) is skipped, and
//!   `/proc`, `/sys`, `/dev` and `/run` are always skipped.
//! - A folder it may not read is counted in `denied`; the walk carries on.
//! - Memory is bounded: a finished folder under the threshold is folded into
//!   its parent, and above [`MAX_FOLDERS`] kept folders the threshold rises.

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashSet};
use std::fs::{self, Metadata};
use std::path::{Path, PathBuf};

/// Kept folders per drive at most.
pub const MAX_FOLDERS: usize = 100_000;
/// Folders under this many bytes are folded to start with.
pub const FIRST_THRESHOLD: u64 = 1024 * 1024;
/// How much the threshold rises when too many folders are kept.
const THRESHOLD_STEP: u64 = 4;
/// The largest files kept per drive.
pub const MAX_LARGEST: usize = 1_000;
/// Never walked, wherever they are mounted.
const SKIPPED: [&str; 4] = ["/proc", "/sys", "/dev", "/run"];

/// One kept folder. `bytes` = `own_bytes` + `folded_bytes` + the children's.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Folder {
    pub name: String,
    pub bytes: u64,
    /// Files in it and under it.
    pub files: u64,
    pub own_bytes: u64,
    pub own_files: u64,
    /// Folders folded into this one, counting what was inside them.
    pub folded_folders: u64,
    pub folded_bytes: u64,
    pub children: Vec<Folder>,
}

impl Folder {
    fn named(name: String) -> Self {
        Self {
            name,
            ..Self::default()
        }
    }

    /// This folder and every kept folder under it.
    fn kept(&self) -> usize {
        1 + self.children.iter().map(Folder::kept).sum::<usize>()
    }

    /// Folders this one stands for: itself, what was folded into it, and
    /// everything kept under it.
    fn folder_count(&self) -> u64 {
        1 + self.folded_folders + self.children.iter().map(Folder::folder_count).sum::<u64>()
    }

    /// Adds a finished sub-folder: kept, or folded in when under `threshold`.
    fn adopt(&mut self, child: Folder, threshold: u64) {
        self.bytes += child.bytes;
        self.files += child.files;
        if child.bytes < threshold {
            self.folded_folders += child.folder_count();
            self.folded_bytes += child.bytes;
        } else {
            self.children.push(child);
        }
    }

    /// Folds every kept folder under `threshold`, all the way down.
    fn refold(&mut self, threshold: u64) {
        let children = std::mem::take(&mut self.children);
        for mut child in children {
            if child.bytes < threshold {
                self.folded_folders += child.folder_count();
                self.folded_bytes += child.bytes;
            } else {
                child.refold(threshold);
                self.children.push(child);
            }
        }
    }

    /// Children biggest first, all the way down (ties by name).
    fn sort(&mut self) {
        self.children
            .sort_by(|a, b| b.bytes.cmp(&a.bytes).then_with(|| a.name.cmp(&b.name)));
        for child in &mut self.children {
            child.sort();
        }
    }
}

/// A large file: bytes, then the path and modified time.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct LargeFile {
    pub bytes: u64,
    pub path: String,
    pub modified_ms: Option<i64>,
}

/// One drive's walk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Walked {
    /// The drive's root; its name is the mount path.
    pub root: Folder,
    pub folders: u64,
    pub denied: u64,
    /// Biggest first.
    pub largest: Vec<LargeFile>,
}

/// What the walk tells whoever runs it, between folders.
pub trait Hooks {
    /// Called after each folder is read, with the bytes counted so far. It
    /// may sleep (pacing, pauses); it returns false to stop the walk.
    fn between_folders(&mut self, counted: u64) -> bool;
}

/// One folder being read: its total so far and the sub-folders still to walk.
struct Open {
    folder: Folder,
    path: PathBuf,
    pending: Vec<String>,
}

/// What a file's entry adds up to.
struct Sized {
    bytes: u64,
    modified_ms: Option<i64>,
}

#[cfg(unix)]
fn device(metadata: &Metadata) -> Option<u64> {
    use std::os::unix::fs::MetadataExt as _;
    Some(metadata.dev())
}

#[cfg(not(unix))]
fn device(_metadata: &Metadata) -> Option<u64> {
    None
}

fn modified_ms(metadata: &Metadata) -> Option<i64> {
    let modified = metadata.modified().ok()?;
    let since = modified.duration_since(std::time::UNIX_EPOCH).ok()?;
    i64::try_from(since.as_millis()).ok()
}

/// Bytes on disk on Linux (allocated blocks), and each hard-linked file once.
#[cfg(unix)]
fn sized(metadata: &Metadata, seen: &mut HashSet<(u64, u64)>) -> Option<Sized> {
    use std::os::unix::fs::MetadataExt as _;
    if metadata.nlink() > 1 && !seen.insert((metadata.dev(), metadata.ino())) {
        return None;
    }
    Some(Sized {
        bytes: metadata.blocks().saturating_mul(512),
        modified_ms: modified_ms(metadata),
    })
}

/// The length on Windows, as Explorer shows it; a cloud placeholder (only
/// online) counts 0 because it is not on the disk.
#[cfg(windows)]
fn sized(metadata: &Metadata, _seen: &mut HashSet<(u64, u64)>) -> Option<Sized> {
    use std::os::windows::fs::MetadataExt as _;
    const FILE_ATTRIBUTE_OFFLINE: u32 = 0x1000;
    const FILE_ATTRIBUTE_RECALL_ON_OPEN: u32 = 0x0004_0000;
    const FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS: u32 = 0x0040_0000;
    let online_only = FILE_ATTRIBUTE_OFFLINE
        | FILE_ATTRIBUTE_RECALL_ON_OPEN
        | FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS;
    let bytes = if metadata.file_attributes() & online_only == 0 {
        metadata.len()
    } else {
        0
    };
    Some(Sized {
        bytes,
        modified_ms: modified_ms(metadata),
    })
}

/// A folder the walk must not enter: a link, junction or other reparse point.
#[cfg(windows)]
fn is_reparse_point(metadata: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt as _;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_reparse_point(_metadata: &Metadata) -> bool {
    false
}

/// The walk's running state.
struct Walk {
    root_device: Option<u64>,
    threshold: u64,
    kept: usize,
    folders: u64,
    denied: u64,
    counted: u64,
    seen_links: HashSet<(u64, u64)>,
    largest: BinaryHeap<Reverse<LargeFile>>,
}

impl Walk {
    fn keep_large(&mut self, file: LargeFile) {
        let small_enough = self.largest.len() >= MAX_LARGEST
            && self
                .largest
                .peek()
                .is_some_and(|Reverse(smallest)| file <= *smallest);
        if small_enough {
            return;
        }
        self.largest.push(Reverse(file));
        if self.largest.len() > MAX_LARGEST {
            self.largest.pop();
        }
    }

    /// Reads one folder: its files are counted now, its sub-folders queued.
    fn open(&mut self, path: PathBuf, name: String) -> Open {
        self.folders += 1;
        let mut folder = Folder::named(name);
        let mut pending = Vec::new();
        match fs::read_dir(&path) {
            Ok(entries) => {
                for entry in entries.flatten() {
                    let Ok(metadata) = entry.metadata() else {
                        continue;
                    };
                    let name = entry.file_name().to_string_lossy().into_owned();
                    if metadata.is_dir() && !is_reparse_point(&metadata) {
                        let child = path.join(&name);
                        let elsewhere = self
                            .root_device
                            .is_some_and(|root| device(&metadata) != Some(root));
                        let skipped = SKIPPED.iter().any(|skip| child == Path::new(skip));
                        if !elsewhere && !skipped {
                            pending.push(name);
                        }
                        continue;
                    }
                    let Some(size) = sized(&metadata, &mut self.seen_links) else {
                        continue;
                    };
                    folder.own_bytes += size.bytes;
                    folder.own_files += 1;
                    if metadata.is_file() {
                        self.keep_large(LargeFile {
                            bytes: size.bytes,
                            path: path.join(&name).to_string_lossy().into_owned(),
                            modified_ms: size.modified_ms,
                        });
                    }
                }
            }
            Err(_) => self.denied += 1,
        }
        folder.bytes = folder.own_bytes;
        folder.files = folder.own_files;
        self.counted += folder.own_bytes;
        // Walked in reverse name order off the end: name order overall.
        pending.sort_by(|a, b| b.cmp(a));
        Open {
            folder,
            path,
            pending,
        }
    }

    /// Too many kept folders: raise the threshold and fold everything again,
    /// the finished tree and the folders still open.
    fn tighten(&mut self, stack: &mut [Open]) {
        while self.kept > MAX_FOLDERS {
            self.threshold = self.threshold.saturating_mul(THRESHOLD_STEP);
            self.kept = 0;
            for open in stack.iter_mut() {
                open.folder.refold(self.threshold);
                self.kept += open.folder.kept() - 1;
            }
        }
    }
}

/// Walks the drive mounted at `mount`. `None` when `hooks` stopped it.
pub fn walk(mount: &Path, hooks: &mut impl Hooks) -> Option<Walked> {
    walk_with(mount, FIRST_THRESHOLD, hooks)
}

/// [`walk`] with a starting threshold (tests use small ones).
pub fn walk_with(mount: &Path, threshold: u64, hooks: &mut impl Hooks) -> Option<Walked> {
    let root_device = fs::symlink_metadata(mount)
        .ok()
        .and_then(|metadata| device(&metadata));
    let mut walk = Walk {
        root_device,
        threshold,
        kept: 0,
        folders: 0,
        denied: 0,
        counted: 0,
        seen_links: HashSet::new(),
        largest: BinaryHeap::new(),
    };
    let root = walk.open(mount.to_path_buf(), mount.to_string_lossy().into_owned());
    let mut stack = vec![root];
    if !hooks.between_folders(walk.counted) {
        return None;
    }
    loop {
        let next = stack.last_mut().and_then(|open| open.pending.pop());
        match next {
            Some(name) => {
                let path = stack
                    .last()
                    .map(|open| open.path.join(&name))
                    .unwrap_or_default();
                let opened = walk.open(path, name);
                stack.push(opened);
                if !hooks.between_folders(walk.counted) {
                    return None;
                }
            }
            None => {
                let Some(done) = stack.pop() else {
                    break;
                };
                match stack.last_mut() {
                    Some(parent) => {
                        let kept = done.folder.bytes >= walk.threshold;
                        let inside = done.folder.kept() - 1;
                        parent.folder.adopt(done.folder, walk.threshold);
                        if kept {
                            walk.kept += 1;
                        } else {
                            walk.kept -= inside;
                        }
                        walk.tighten(&mut stack);
                    }
                    None => {
                        let mut root = done.folder;
                        root.sort();
                        let mut largest: Vec<LargeFile> =
                            walk.largest.into_iter().map(|Reverse(file)| file).collect();
                        largest.sort_by(|a, b| b.cmp(a));
                        return Some(Walked {
                            root,
                            folders: walk.folders,
                            denied: walk.denied,
                            largest,
                        });
                    }
                }
            }
        }
    }
    None
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt as _};

    struct Count(usize);

    impl Hooks for Count {
        fn between_folders(&mut self, _counted: u64) -> bool {
            self.0 += 1;
            true
        }
    }

    /// Writes `bytes` bytes that really take blocks (not a sparse file).
    fn file(path: &Path, bytes: usize) {
        fs::write(path, vec![7u8; bytes]).unwrap();
    }

    fn on_disk(path: &Path) -> u64 {
        use std::os::unix::fs::MetadataExt as _;
        fs::symlink_metadata(path).unwrap().blocks() * 512
    }

    fn child<'a>(folder: &'a Folder, name: &str) -> &'a Folder {
        folder
            .children
            .iter()
            .find(|child| child.name == name)
            .unwrap_or_else(|| panic!("{name} is not kept in {}", folder.name))
    }

    #[test]
    fn s1_totals_folders_counts_hard_links_once_and_never_follows_links() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("big/inner")).unwrap();
        fs::create_dir(root.join("small")).unwrap();
        file(&root.join("big/a.bin"), 200_000);
        file(&root.join("big/inner/b.bin"), 300_000);
        file(&root.join("small/c.txt"), 10);
        fs::hard_link(root.join("big/a.bin"), root.join("big/a-again.bin")).unwrap();
        // A link to a big folder elsewhere is the link itself, not walked.
        let outside = tempfile::tempdir().unwrap();
        file(&outside.path().join("huge.bin"), 1_000_000);
        symlink(outside.path(), root.join("away")).unwrap();

        let walked = walk_with(root, 1, &mut Count(0)).unwrap();
        let a = on_disk(&root.join("big/a.bin"));
        let b = on_disk(&root.join("big/inner/b.bin"));
        let c = on_disk(&root.join("small/c.txt"));
        let link = on_disk(&root.join("away"));
        let big = child(&walked.root, "big");
        assert_eq!(big.bytes, a + b, "the hard link counts once");
        assert_eq!(big.own_bytes, a);
        assert_eq!(child(big, "inner").bytes, b);
        assert_eq!(walked.root.bytes, a + b + c + link);
        assert_eq!(walked.root.files, 4, "a, b, c and the link");
        assert_eq!(walked.folders, 4);
        assert!(walked
            .largest
            .iter()
            .all(|large| !large.path.contains("huge")));
        assert_eq!(
            walked.largest[0].path,
            root.join("big/inner/b.bin").to_string_lossy()
        );
    }

    #[test]
    fn s1_an_unreadable_folder_is_counted_and_the_walk_carries_on() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir(root.join("locked")).unwrap();
        fs::create_dir(root.join("open")).unwrap();
        file(&root.join("open/x.bin"), 50_000);
        fs::set_permissions(root.join("locked"), fs::Permissions::from_mode(0o000)).unwrap();
        let walked = walk_with(root, 1, &mut Count(0)).unwrap();
        fs::set_permissions(root.join("locked"), fs::Permissions::from_mode(0o755)).unwrap();
        // Root reads every folder anyway; as anyone else the locked one is denied.
        let as_root = unsafe { libc::geteuid() } == 0;
        assert_eq!(walked.denied, u64::from(!as_root));
        assert_eq!(child(&walked.root, "open").files, 1);
    }

    #[test]
    fn s2_system_folders_are_never_walked() {
        assert!(SKIPPED.contains(&"/proc") && SKIPPED.contains(&"/run"));
        // The real /: walk only its top level, then stop.
        struct Once;
        impl Hooks for Once {
            fn between_folders(&mut self, _counted: u64) -> bool {
                false
            }
        }
        assert!(walk(Path::new("/"), &mut Once).is_none());
        let mut walk = Walk {
            root_device: fs::symlink_metadata("/").ok().and_then(|m| device(&m)),
            threshold: 1,
            kept: 0,
            folders: 0,
            denied: 0,
            counted: 0,
            seen_links: HashSet::new(),
            largest: BinaryHeap::new(),
        };
        let open = walk.open(PathBuf::from("/"), "/".into());
        for skipped in ["proc", "sys", "dev", "run"] {
            assert!(
                !open.pending.iter().any(|name| name == skipped),
                "{skipped}"
            );
        }
    }

    #[test]
    fn s2_another_device_is_skipped() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("here")).unwrap();
        let mut walk = Walk {
            // A device the folder is not on: everything under it is elsewhere.
            root_device: Some(u64::MAX),
            threshold: 1,
            kept: 0,
            folders: 0,
            denied: 0,
            counted: 0,
            seen_links: HashSet::new(),
            largest: BinaryHeap::new(),
        };
        let open = walk.open(dir.path().to_path_buf(), "root".into());
        assert!(open.pending.is_empty());
    }

    #[test]
    fn s3_small_folders_fold_into_their_parent() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("big/tiny/tinier")).unwrap();
        file(&root.join("big/payload.bin"), 400_000);
        file(&root.join("big/tiny/t.txt"), 10);
        file(&root.join("big/tiny/tinier/u.txt"), 10);
        let walked = walk_with(root, 100_000, &mut Count(0)).unwrap();
        let big = child(&walked.root, "big");
        assert!(big.children.is_empty());
        assert_eq!(big.folded_folders, 2, "tiny and tinier");
        assert_eq!(
            big.folded_bytes,
            on_disk(&root.join("big/tiny/t.txt")) + on_disk(&root.join("big/tiny/tinier/u.txt"))
        );
        assert_eq!(big.files, 3);
        assert_eq!(big.bytes, big.own_bytes + big.folded_bytes);
    }

    #[test]
    fn s3_too_many_folders_raise_the_threshold() {
        let mut parent = Folder::named("p".into());
        for index in 0..5u64 {
            let mut child = Folder::named(format!("c{index}"));
            child.bytes = 10 + index;
            child.own_bytes = child.bytes;
            parent.adopt(child, 1);
        }
        assert_eq!(parent.children.len(), 5);
        parent.refold(13);
        assert_eq!(parent.children.len(), 2, "13 and 14 stay");
        assert_eq!(parent.folded_folders, 3);
        assert_eq!(parent.folded_bytes, 10 + 11 + 12);
        assert_eq!(parent.bytes, 10 + 11 + 12 + 13 + 14);
    }

    #[test]
    fn s3_only_the_largest_files_are_kept_biggest_first() {
        let mut walk = Walk {
            root_device: None,
            threshold: 1,
            kept: 0,
            folders: 0,
            denied: 0,
            counted: 0,
            seen_links: HashSet::new(),
            largest: BinaryHeap::new(),
        };
        for bytes in 0..(MAX_LARGEST as u64 + 500) {
            walk.keep_large(LargeFile {
                bytes,
                path: format!("/f{bytes}"),
                modified_ms: None,
            });
        }
        assert_eq!(walk.largest.len(), MAX_LARGEST);
        let smallest = walk.largest.peek().map(|Reverse(file)| file.bytes);
        assert_eq!(smallest, Some(500));
    }

    #[test]
    fn a_stopped_walk_returns_nothing() {
        struct Stop;
        impl Hooks for Stop {
            fn between_folders(&mut self, _counted: u64) -> bool {
                false
            }
        }
        let dir = tempfile::tempdir().unwrap();
        assert!(walk(dir.path(), &mut Stop).is_none());
    }
}
