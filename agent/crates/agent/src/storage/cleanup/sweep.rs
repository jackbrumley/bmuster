//! The safe sweep (SPEC-STORAGE 11.3): sizes, then deletes, the files of a
//! clean-up item's folders. Sizing and cleaning walk the same way with the
//! same rules, so the size shown is what a clean-up tries to delete.
//!
//! - Roots are checked part by part below a trusted system folder
//!   ([`checked_root`]); a link anywhere drops the root.
//! - Entries are read without following them; links, junctions and other
//!   reparse points are never entered or deleted, and only regular files
//!   are deleted, then folders the sweep emptied.
//! - It never leaves the root's device.
//! - Each delete goes through [`super::safe::remove`], bound to the folder
//!   that was listed.

use super::safe::{self, Kind, Removal};
use bmuster_protocol::cleanup::MAX_MESSAGES;
use std::ffi::{OsStr, OsString};
use std::fs::{self, Metadata};
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

/// Which files of a root an item takes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Rule {
    /// Only files none of whose times are newer than this.
    pub min_age: Option<Duration>,
    /// Only files with this extension (`deb`, `rpm`, `journal`).
    pub extension: Option<&'static str>,
    /// Only this one file, directly in the root (`MEMORY.DMP`).
    pub only_name: Option<&'static str>,
    /// Folders directly in the root stay (the Recycle Bin's per-person folders).
    pub keep_top_folders: bool,
    /// Names never deleted, anywhere (`desktop.ini`).
    pub keep_names: &'static [&'static str],
    /// Folders directly in the root left alone, by the start of their name
    /// (`systemd-private-`).
    pub skip_top_prefixes: &'static [&'static str],
}

/// One checked root and its rule.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub root: PathBuf,
    pub rule: Rule,
}

/// A root as [`checked_root`] found it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Root {
    /// It does not exist: nothing to do, and not an error.
    Missing,
    /// A part of it is a link or not a folder: never swept.
    Linked(PathBuf),
    /// The real path (no links), ready to sweep.
    Ready(PathBuf),
}

/// A link, junction or other reparse point.
pub fn is_link(metadata: &Metadata) -> bool {
    metadata.file_type().is_symlink() || is_reparse_point(metadata)
}

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

/// `base` (a system folder, resolved to its real path) with `parts` below
/// it, when every part is a real folder. A person may own a part (their
/// home, their temp folder), so a link in any part drops the root.
pub fn checked_root(base: &Path, parts: &[&OsStr]) -> Root {
    let mut path = match fs::canonicalize(base) {
        Ok(path) => path,
        Err(_) => return Root::Missing,
    };
    for part in parts {
        path.push(part);
        match fs::symlink_metadata(&path) {
            Err(_) => return Root::Missing,
            Ok(metadata) if is_link(&metadata) || !metadata.is_dir() => return Root::Linked(path),
            Ok(_) => {}
        }
    }
    Root::Ready(path)
}

/// The real folders directly in `folder` (profiles, homes), links left out.
pub fn real_folders(folder: &Path) -> Vec<OsString> {
    let Ok(entries) = fs::read_dir(folder) else {
        return Vec::new();
    };
    let mut names: Vec<OsString> = entries
        .flatten()
        .filter(|entry| {
            entry
                .metadata()
                .is_ok_and(|metadata| metadata.is_dir() && !is_link(&metadata))
        })
        .map(|entry| entry.file_name())
        .collect();
    names.sort();
    names
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

/// The bytes deleting the file frees: allocated blocks on Linux, nothing
/// for a file with other hard links (its data stays); the length on Windows.
#[cfg(unix)]
pub fn freed_by(metadata: &Metadata) -> u64 {
    use std::os::unix::fs::MetadataExt as _;
    if metadata.nlink() > 1 {
        0
    } else {
        metadata.blocks().saturating_mul(512)
    }
}

#[cfg(not(unix))]
pub fn freed_by(metadata: &Metadata) -> u64 {
    metadata.len()
}

/// Every time the system keeps for the entry: access, modified and change
/// (Linux) or created (Windows).
fn times(metadata: &Metadata) -> Vec<SystemTime> {
    let mut times: Vec<SystemTime> = [metadata.accessed(), metadata.modified()]
        .into_iter()
        .flatten()
        .collect();
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt as _;
        let change = u64::try_from(metadata.ctime())
            .ok()
            .and_then(|seconds| SystemTime::UNIX_EPOCH.checked_add(Duration::from_secs(seconds)));
        times.extend(change);
    }
    #[cfg(not(unix))]
    times.extend(metadata.created());
    times
}

/// Whether every time is at least `min_age` before `now`. No times at all
/// is never old.
pub fn old_enough(times: &[SystemTime], now: SystemTime, min_age: Duration) -> bool {
    let Some(cut) = now.checked_sub(min_age) else {
        return false;
    };
    !times.is_empty() && times.iter().all(|time| *time <= cut)
}

fn same_name(a: &OsStr, b: &str) -> bool {
    a.to_str().is_some_and(|a| a.eq_ignore_ascii_case(b))
}

impl Rule {
    fn takes_file(&self, name: &OsStr, metadata: &Metadata, depth: usize, now: SystemTime) -> bool {
        if self.keep_names.iter().any(|kept| same_name(name, kept)) {
            return false;
        }
        if let Some(only) = self.only_name {
            if depth > 0 || !same_name(name, only) {
                return false;
            }
        }
        if let Some(extension) = self.extension {
            let matches = Path::new(name)
                .extension()
                .is_some_and(|found| same_name(found, extension));
            if !matches {
                return false;
            }
        }
        self.is_old(metadata, now)
    }

    fn is_old(&self, metadata: &Metadata, now: SystemTime) -> bool {
        self.min_age
            .is_none_or(|age| old_enough(&times(metadata), now, age))
    }

    fn enters(&self, name: &OsStr, depth: usize) -> bool {
        if self.only_name.is_some() {
            return false;
        }
        depth > 0
            || !self
                .skip_top_prefixes
                .iter()
                .any(|prefix| name.to_str().is_some_and(|name| name.starts_with(prefix)))
    }
}

/// What sizing found.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Tally {
    pub bytes: u64,
    pub files: u64,
}

/// What cleaning did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Outcome {
    pub freed_bytes: u64,
    pub removed: u64,
    pub skipped: u64,
    pub errors: u64,
    pub messages: Vec<String>,
}

impl Outcome {
    pub fn error(&mut self, message: String) {
        self.errors += 1;
        if self.messages.len() < MAX_MESSAGES {
            self.messages.push(message);
        }
    }

    pub fn add(&mut self, other: Outcome) {
        self.freed_bytes += other.freed_bytes;
        self.removed += other.removed;
        self.skipped += other.skipped;
        for message in other.messages {
            if self.messages.len() < MAX_MESSAGES {
                self.messages.push(message);
            }
        }
        self.errors += other.errors;
    }
}

/// A folder the walk will come back to after its contents, to remove it
/// if it ended up empty.
struct Leave {
    parent: PathBuf,
    name: OsString,
    metadata: Metadata,
}

enum Step {
    Enter { folder: PathBuf, depth: usize },
    Leave(Leave),
}

/// What the walk does with each file it takes.
trait Visit {
    fn file(&mut self, folder: &Path, name: &OsStr, metadata: &Metadata);
    fn emptied(&mut self, leave: &Leave);
    fn unreadable(&mut self, folder: &Path, error: &io::Error);
}

fn walk(target: &Target, now: SystemTime, visit: &mut impl Visit) {
    let root_device = fs::symlink_metadata(&target.root)
        .ok()
        .and_then(|metadata| device(&metadata));
    let mut steps = vec![Step::Enter {
        folder: target.root.clone(),
        depth: 0,
    }];
    while let Some(step) = steps.pop() {
        let (folder, depth) = match step {
            Step::Enter { folder, depth } => (folder, depth),
            Step::Leave(leave) => {
                visit.emptied(&leave);
                continue;
            }
        };
        let entries = match fs::read_dir(&folder) {
            Ok(entries) => entries,
            Err(e) => {
                visit.unreadable(&folder, &e);
                continue;
            }
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            // `DirEntry::metadata` never follows a link.
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            if is_link(&metadata) {
                continue;
            }
            if metadata.is_dir() {
                let elsewhere = root_device.is_some_and(|root| device(&metadata) != Some(root));
                if elsewhere || !target.rule.enters(&name, depth) {
                    continue;
                }
                let child = folder.join(&name);
                let kept = depth == 0 && target.rule.keep_top_folders;
                if !kept && target.rule.is_old(&metadata, now) {
                    steps.push(Step::Leave(Leave {
                        parent: folder.clone(),
                        name: name.clone(),
                        metadata,
                    }));
                }
                steps.push(Step::Enter {
                    folder: child,
                    depth: depth + 1,
                });
            } else if metadata.is_file() && target.rule.takes_file(&name, &metadata, depth, now) {
                visit.file(&folder, &name, &metadata);
            }
        }
    }
}

struct Sizing(Tally);

impl Visit for Sizing {
    fn file(&mut self, _folder: &Path, _name: &OsStr, metadata: &Metadata) {
        self.0.bytes += freed_by(metadata);
        self.0.files += 1;
    }
    fn emptied(&mut self, _leave: &Leave) {}
    fn unreadable(&mut self, _folder: &Path, _error: &io::Error) {}
}

/// What deleting the item's files would free now.
pub fn size(targets: &[Target], now: SystemTime) -> Tally {
    let mut sizing = Sizing(Tally::default());
    for target in targets {
        walk(target, now, &mut sizing);
    }
    sizing.0
}

struct Cleaning<'a> {
    outcome: Outcome,
    progress: &'a mut dyn FnMut(&Outcome),
}

impl Visit for Cleaning<'_> {
    fn file(&mut self, folder: &Path, name: &OsStr, metadata: &Metadata) {
        match safe::remove(folder, name, metadata, Kind::File) {
            Removal::Removed => {
                self.outcome.freed_bytes += freed_by(metadata);
                self.outcome.removed += 1;
            }
            Removal::InUse | Removal::Denied | Removal::Changed | Removal::NotEmpty => {
                self.outcome.skipped += 1;
            }
            Removal::Failed(message) => self.outcome.error(format!(
                "Could not delete {}: {message}",
                folder.join(name).display()
            )),
        }
        (self.progress)(&self.outcome);
    }

    fn emptied(&mut self, leave: &Leave) {
        // A folder that still holds something (skipped, too new, a link) stays.
        if let Removal::Failed(message) =
            safe::remove(&leave.parent, &leave.name, &leave.metadata, Kind::Folder)
        {
            self.outcome.error(format!(
                "Could not remove the folder {}: {message}",
                leave.parent.join(&leave.name).display()
            ));
        }
    }

    fn unreadable(&mut self, folder: &Path, error: &io::Error) {
        if error.kind() == io::ErrorKind::PermissionDenied {
            self.outcome.skipped += 1;
        } else {
            self.outcome
                .error(format!("Could not read {}: {error}", folder.display()));
        }
    }
}

/// Deletes the item's files; `progress` hears after each one.
pub fn clean(targets: &[Target], now: SystemTime, progress: &mut dyn FnMut(&Outcome)) -> Outcome {
    let mut cleaning = Cleaning {
        outcome: Outcome::default(),
        progress,
    };
    for target in targets {
        walk(target, now, &mut cleaning);
    }
    cleaning.outcome
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt as _};

    const DAY: Duration = Duration::from_secs(24 * 60 * 60);

    fn tree() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        (dir, root)
    }

    fn write(path: &Path, bytes: usize) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, vec![7u8; bytes]).unwrap();
    }

    fn ready(base: &Path, parts: &[&str]) -> Target {
        let parts: Vec<&OsStr> = parts.iter().map(OsStr::new).collect();
        match checked_root(base, &parts) {
            Root::Ready(root) => Target {
                root,
                rule: Rule::default(),
            },
            other => panic!("not ready: {other:?}"),
        }
    }

    fn quietly(_: &Outcome) {}

    #[test]
    fn s12_sizes_and_deletes_only_regular_files_inside_the_root() {
        let (_dir, base) = tree();
        write(&base.join("cache/a.bin"), 10_000);
        write(&base.join("cache/deep/er/b.bin"), 5_000);
        write(&base.join("outside/precious"), 100);
        symlink(base.join("outside"), base.join("cache/link-to-outside")).unwrap();
        symlink(base.join("outside/precious"), base.join("cache/file-link")).unwrap();
        let target = ready(&base, &["cache"]);

        let tally = size(std::slice::from_ref(&target), SystemTime::now());
        assert_eq!(tally.files, 2, "links are neither sized nor followed");
        assert!(tally.bytes >= 15_000);

        let outcome = clean(&[target], SystemTime::now(), &mut quietly);
        assert_eq!(outcome.removed, 2);
        assert_eq!(outcome.freed_bytes, tally.bytes);
        assert_eq!(outcome.errors, 0);
        assert!(
            base.join("outside/precious").exists(),
            "never through a link"
        );
        assert!(
            fs::symlink_metadata(base.join("cache/link-to-outside")).is_ok(),
            "links stay"
        );
        assert!(fs::symlink_metadata(base.join("cache/file-link")).is_ok());
        assert!(!base.join("cache/deep").exists(), "emptied folders go");
        assert!(base.join("cache").is_dir(), "the root stays");
    }

    #[test]
    fn s12_kept_folders_names_and_single_files() {
        let (_dir, base) = tree();
        write(&base.join("bin/S-1-5-21/$RABC.txt"), 10);
        write(&base.join("bin/S-1-5-21/desktop.ini"), 10);
        write(&base.join("bin/S-1-5-21/$RDEF/inner"), 10);
        let mut bin = ready(&base, &["bin"]);
        bin.rule = Rule {
            keep_top_folders: true,
            keep_names: &["desktop.ini"],
            ..Rule::default()
        };
        let outcome = clean(&[bin], SystemTime::now(), &mut quietly);
        assert_eq!(outcome.removed, 2);
        assert!(base.join("bin/S-1-5-21/desktop.ini").exists());
        assert!(!base.join("bin/S-1-5-21/$RDEF").exists());
        assert!(base.join("bin/S-1-5-21").is_dir());

        write(&base.join("win/MEMORY.DMP"), 10);
        write(&base.join("win/other.dmp"), 10);
        write(&base.join("win/sub/MEMORY.DMP"), 10);
        let mut dump = ready(&base, &["win"]);
        dump.rule = Rule {
            only_name: Some("MEMORY.DMP"),
            ..Rule::default()
        };
        assert_eq!(
            size(std::slice::from_ref(&dump), SystemTime::now()).files,
            1
        );
        clean(&[dump], SystemTime::now(), &mut quietly);
        assert!(!base.join("win/MEMORY.DMP").exists());
        assert!(base.join("win/other.dmp").exists());
        assert!(base.join("win/sub/MEMORY.DMP").exists());

        write(&base.join("apt/a.deb"), 10);
        write(&base.join("apt/partial/b.deb"), 10);
        write(&base.join("apt/lock"), 10);
        let mut apt = ready(&base, &["apt"]);
        apt.rule = Rule {
            extension: Some("deb"),
            ..Rule::default()
        };
        assert_eq!(size(&[apt], SystemTime::now()).files, 2);
    }

    #[test]
    fn s13_a_root_with_a_link_in_it_is_never_swept() {
        let (_dir, base) = tree();
        write(&base.join("etc/shadow"), 10);
        fs::create_dir_all(base.join("home/bob/.cache")).unwrap();
        symlink(base.join("etc"), base.join("home/bob/.cache/thumbnails")).unwrap();
        let parts = [
            OsStr::new("bob"),
            OsStr::new(".cache"),
            OsStr::new("thumbnails"),
        ];
        assert!(matches!(
            checked_root(&base.join("home"), &parts),
            Root::Linked(_)
        ));
        fs::remove_file(base.join("home/bob/.cache/thumbnails")).unwrap();
        fs::remove_dir(base.join("home/bob/.cache")).unwrap();
        symlink(base.join("etc"), base.join("home/bob/.cache")).unwrap();
        assert!(matches!(
            checked_root(&base.join("home"), &parts),
            Root::Linked(_)
        ));
        assert_eq!(checked_root(&base.join("nowhere"), &[]), Root::Missing);
        assert_eq!(
            checked_root(&base.join("home"), &[OsStr::new("alice")]),
            Root::Missing
        );
        assert_eq!(
            real_folders(&base.join("home")),
            vec![OsString::from("bob")]
        );
        assert!(base.join("etc/shadow").exists());
    }

    #[test]
    fn s14_only_files_older_than_the_rule_by_every_time() {
        let (_dir, base) = tree();
        write(&base.join("tmp/old"), 10);
        write(&base.join("tmp/systemd-private-x/tmp/old"), 10);
        write(&base.join("tmp/sub/old"), 10);
        let mut target = ready(&base, &["tmp"]);
        target.rule = Rule {
            min_age: Some(30 * DAY),
            skip_top_prefixes: &["systemd-private-"],
            ..Rule::default()
        };
        let now = SystemTime::now();
        assert_eq!(size(std::slice::from_ref(&target), now).files, 0, "all new");
        let later = now + 31 * DAY;
        assert_eq!(size(std::slice::from_ref(&target), later).files, 2);
        let outcome = clean(&[target], later, &mut quietly);
        assert_eq!(outcome.removed, 2);
        assert!(base.join("tmp/systemd-private-x/tmp/old").exists());
        assert!(
            !base.join("tmp/sub").exists(),
            "an old folder it emptied goes"
        );

        let t = |days: u32| now - DAY * days;
        assert!(old_enough(&[t(40), t(31)], now, 30 * DAY));
        assert!(
            !old_enough(&[t(40), t(2)], now, 30 * DAY),
            "one recent time keeps it"
        );
        assert!(!old_enough(&[], now, 30 * DAY));
    }

    #[test]
    fn s14_a_recently_read_file_is_kept() {
        let (_dir, base) = tree();
        write(&base.join("tmp/read-yesterday"), 10);
        let file = fs::File::options()
            .write(true)
            .open(base.join("tmp/read-yesterday"))
            .unwrap();
        let old = SystemTime::now() - 60 * DAY;
        file.set_times(fs::FileTimes::new().set_modified(old))
            .unwrap();
        let mut target = ready(&base, &["tmp"]);
        target.rule.min_age = Some(30 * DAY);
        assert_eq!(size(&[target], SystemTime::now()).files, 0);
    }

    #[test]
    fn s15_denied_files_are_skipped_and_counted() {
        if unsafe { libc::geteuid() } == 0 {
            return; // root may delete anything; the check needs an ordinary account
        }
        let (_dir, base) = tree();
        write(&base.join("cache/free"), 10);
        write(&base.join("cache/locked/a"), 10);
        write(&base.join("cache/locked/b"), 10);
        write(&base.join("cache/sealed/c"), 10);
        fs::set_permissions(base.join("cache/locked"), fs::Permissions::from_mode(0o555)).unwrap();
        fs::set_permissions(base.join("cache/sealed"), fs::Permissions::from_mode(0o000)).unwrap();
        let target = ready(&base, &["cache"]);
        let outcome = clean(&[target], SystemTime::now(), &mut quietly);
        fs::set_permissions(base.join("cache/locked"), fs::Permissions::from_mode(0o755)).unwrap();
        fs::set_permissions(base.join("cache/sealed"), fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(outcome.removed, 1);
        assert_eq!(
            outcome.skipped, 3,
            "two denied files and one unreadable folder"
        );
        assert_eq!(outcome.errors, 0);
        assert!(base.join("cache/locked/a").exists());
    }

    #[test]
    fn s15_results_count_and_keep_a_few_messages() {
        let mut outcome = Outcome::default();
        for n in 0..8 {
            outcome.error(format!("e{n}"));
        }
        assert_eq!(outcome.errors, 8);
        assert_eq!(outcome.messages.len(), MAX_MESSAGES);
        let mut total = Outcome {
            freed_bytes: 1,
            removed: 1,
            ..Outcome::default()
        };
        total.add(outcome);
        assert_eq!((total.freed_bytes, total.removed, total.errors), (1, 1, 8));
    }

    #[test]
    fn s12_hard_linked_files_free_nothing() {
        let (_dir, base) = tree();
        write(&base.join("cache/a"), 8192);
        fs::hard_link(base.join("cache/a"), base.join("kept")).unwrap();
        let target = ready(&base, &["cache"]);
        let outcome = clean(&[target], SystemTime::now(), &mut quietly);
        assert_eq!((outcome.removed, outcome.freed_bytes), (1, 0));
        assert!(base.join("kept").exists());
    }
}
