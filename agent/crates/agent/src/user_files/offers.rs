//! Files copied on the machine, offered for download (SPEC-SESSION-FILES
//! 3.2, SF22, SF24, SF28), in the helper, as the person.
//!
//! The offer is the clipboard's file list when it was looked at: a new
//! copy replaces it (a fresh 128-bit id), an hour ends it, and the files
//! BMuster itself put there are never offered back. The server and the
//! browser see names, sizes and an id, never a path; a download names the
//! offer and an entry number of the walk the helper did.
//!
//! Reading is the person's own: a file they cannot read fails as `denied`
//! whoever put it on the clipboard. Links are never followed (a copied
//! link and links inside folders are skipped); devices, sockets and pipes
//! are skipped and listed; folders are walked at most 32 levels and
//! 10,000 items deep. A file whose size or modified time changes while it
//! is read fails as `changed`.

use super::clipboard::FileClipboard;
use super::UserError;
use crate::files::transfer::Credit;
use bmuster_desktop::clipboard::files::CopiedItem;
use bmuster_protocol::files::READ_FRAME_BYTES;
use bmuster_protocol::user_files::{
    Offer, OfferItem, OfferKind, Skipped, UserFilesError, UserFilesResult, WalkEntry,
    MAX_OFFER_ITEMS, MAX_WALK_DEPTH, MAX_WALK_ITEMS, OFFER_MAX_AGE_MS,
};
use std::fs::{File, Metadata};
use std::io::{Read as _, Seek as _, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant, SystemTime};

/// One file of a walk: where it is and what it was when walked.
#[derive(Debug, Clone)]
pub struct Entry {
    pub shown: String,
    pub path: PathBuf,
    pub size: u64,
    pub modified_ms: u64,
}

struct Current {
    id: String,
    paths: Vec<PathBuf>,
    noticed: Instant,
    offer: Offer,
    walk: Vec<Entry>,
}

/// The helper's offers.
#[derive(Default)]
pub struct Offers {
    current: Option<Current>,
    /// What the helper itself last put on the clipboard (never offered back).
    ours: Option<Vec<PathBuf>>,
    /// A list whose offer ran out: not offered again until the clipboard changes.
    expired: Option<Vec<PathBuf>>,
}

fn modified_ms(metadata: &Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map_or(0, |since| {
            u64::try_from(since.as_millis()).unwrap_or(u64::MAX)
        })
}

fn new_id() -> String {
    let mut bytes = [0u8; 16];
    if getrandom::getrandom(&mut bytes).is_err() {
        // A clock-based id still changes with each copy; it is never a secret.
        let now = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map_or(0, |since| since.as_nanos());
        bytes = now.to_le_bytes();
    }
    hex::encode(bytes)
}

fn name_of(path: &Path) -> String {
    path.file_name().map_or_else(
        || path.to_string_lossy().into_owned(),
        |name| name.to_string_lossy().into_owned(),
    )
}

fn gone() -> UserError {
    UserError::new(
        UserFilesError::Gone,
        "Those files are no longer on the machine's clipboard. Copy them again.",
    )
}

impl Offers {
    /// The files BMuster put on the clipboard after a drop (echoes).
    pub fn put_by_us(&mut self, paths: Vec<PathBuf>) {
        self.ours = Some(paths);
    }

    /// Looks at the clipboard: the current offer, a new one, or none.
    pub fn look(
        &mut self,
        clipboard: &mut dyn FileClipboard,
        now: Instant,
    ) -> Result<UserFilesResult, UserError> {
        let read = clipboard
            .read()
            .map_err(|error| UserError::new(UserFilesError::Io, error))?;
        let Some(items) = read else {
            self.current = None;
            self.expired = None;
            return Ok(UserFilesResult::Offered { offer: None });
        };
        let paths: Vec<PathBuf> = items
            .iter()
            .filter_map(|item| match item {
                CopiedItem::Local(path) => Some(path.clone()),
                CopiedItem::NotLocal => None,
            })
            .collect();
        if paths.is_empty() {
            self.current = None;
            return if items.is_empty() {
                Ok(UserFilesResult::Offered { offer: None })
            } else {
                Err(UserError::new(
                    UserFilesError::NotLocal,
                    "These files are not on this machine's disks.",
                ))
            };
        }
        if self.ours.as_ref() == Some(&paths) {
            self.current = None;
            return Ok(UserFilesResult::Offered { offer: None });
        }
        if self.expired.as_ref() == Some(&paths) {
            return Ok(UserFilesResult::Offered { offer: None });
        }
        self.expired = None;
        if let Some(current) = &self.current {
            if current.paths == paths {
                if now.duration_since(current.noticed) > Duration::from_millis(OFFER_MAX_AGE_MS) {
                    self.expired = Some(paths);
                    self.current = None;
                    return Ok(UserFilesResult::Offered { offer: None });
                }
                return Ok(UserFilesResult::Offered {
                    offer: Some(current.offer.clone()),
                });
            }
        }
        let mut listed = Vec::new();
        let mut total = 0u64;
        for path in &paths {
            // As the person: what they cannot see is left out of the list.
            let Ok(metadata) = std::fs::symlink_metadata(path) else {
                continue;
            };
            let (kind, size) = if metadata.is_dir() {
                (OfferKind::Folder, 0)
            } else if metadata.is_file() {
                (OfferKind::File, metadata.len())
            } else {
                continue;
            };
            total = total.saturating_add(size);
            listed.push(OfferItem {
                name: name_of(path),
                kind,
                size,
            });
        }
        let count = listed.len();
        if count == 0 {
            self.current = None;
            return Ok(UserFilesResult::Offered { offer: None });
        }
        listed.truncate(MAX_OFFER_ITEMS);
        let id = new_id();
        let offer = Offer {
            offer_id: id.clone(),
            items: listed,
            count,
            total_bytes: total,
        };
        self.current = Some(Current {
            id,
            paths,
            noticed: now,
            offer: offer.clone(),
            walk: Vec::new(),
        });
        Ok(UserFilesResult::Offered { offer: Some(offer) })
    }

    fn current(&mut self, offer_id: &str, now: Instant) -> Result<&mut Current, UserError> {
        match self.current.as_mut() {
            Some(current)
                if current.id == offer_id
                    && now.duration_since(current.noticed)
                        <= Duration::from_millis(OFFER_MAX_AGE_MS) =>
            {
                Ok(current)
            }
            _ => Err(gone()),
        }
    }

    /// Walks the offer: every file to send, and what was left out.
    pub fn walk(&mut self, offer_id: &str, now: Instant) -> Result<UserFilesResult, UserError> {
        let current = self.current(offer_id, now)?;
        let mut walk = Walk::default();
        for path in &current.paths {
            walk.top(path)?;
        }
        let single = current.paths.len() == 1 && walk.entries.len() == 1 && walk.top_files == 1;
        let entries = walk
            .entries
            .iter()
            .map(|entry| WalkEntry {
                path: entry.shown.clone(),
                size: entry.size,
                modified_ms: entry.modified_ms,
            })
            .collect();
        current.walk = walk.entries;
        Ok(UserFilesResult::Walked {
            entries,
            skipped: walk.skipped,
            single,
        })
    }

    /// The walked entry `entry` of the offer, for a read.
    pub fn entry(&mut self, offer_id: &str, entry: u32, now: Instant) -> Result<Entry, UserError> {
        let current = self.current(offer_id, now)?;
        current
            .walk
            .get(entry as usize)
            .cloned()
            .ok_or_else(|| UserError::invalid("That file is not part of the copied files."))
    }
}

#[derive(Default)]
struct Walk {
    entries: Vec<Entry>,
    skipped: Vec<Skipped>,
    top_files: usize,
    seen: usize,
}

fn denied(name: &str) -> UserError {
    UserError::new(
        UserFilesError::Denied,
        format!("You don't have permission to read {name} on the machine."),
    )
}

impl Walk {
    fn count(&mut self) -> Result<(), UserError> {
        self.seen += 1;
        if self.seen > MAX_WALK_ITEMS {
            return Err(UserError::invalid(format!(
                "The copied folders hold more than {MAX_WALK_ITEMS} items. Copy fewer at a time."
            )));
        }
        Ok(())
    }

    fn top(&mut self, path: &Path) -> Result<(), UserError> {
        let name = name_of(path);
        let metadata = std::fs::symlink_metadata(path).map_err(|error| {
            if error.kind() == std::io::ErrorKind::PermissionDenied {
                denied(&name)
            } else {
                UserError::new(
                    UserFilesError::Gone,
                    format!("{name} is no longer on the machine."),
                )
            }
        })?;
        self.count()?;
        if metadata.is_file() {
            self.top_files += 1;
            self.entries.push(Entry {
                shown: name,
                path: path.to_path_buf(),
                size: metadata.len(),
                modified_ms: modified_ms(&metadata),
            });
        } else if metadata.is_dir() {
            if std::fs::read_dir(path).is_err() {
                return Err(denied(&name));
            }
            self.folder(path, &name, 1)?;
        } else {
            self.skipped.push(Skipped {
                path: name,
                reason: kind_reason(&metadata).into(),
            });
        }
        Ok(())
    }

    fn folder(&mut self, path: &Path, shown: &str, depth: usize) -> Result<(), UserError> {
        if depth > MAX_WALK_DEPTH {
            self.skipped.push(Skipped {
                path: shown.into(),
                reason: format!("more than {MAX_WALK_DEPTH} folders deep"),
            });
            return Ok(());
        }
        let entries = match std::fs::read_dir(path) {
            Ok(entries) => entries,
            Err(error) => {
                self.skipped.push(Skipped {
                    path: shown.into(),
                    reason: error.to_string(),
                });
                return Ok(());
            }
        };
        let mut children: Vec<_> = entries.flatten().collect();
        children.sort_by_key(std::fs::DirEntry::file_name);
        for child in children {
            self.count()?;
            let name = child.file_name().to_string_lossy().into_owned();
            let inner = format!("{shown}/{name}");
            // `file_type` and `symlink_metadata` never follow a link.
            let Ok(metadata) = std::fs::symlink_metadata(child.path()) else {
                self.skipped.push(Skipped {
                    path: inner,
                    reason: "could not be read".into(),
                });
                continue;
            };
            if metadata.is_dir() {
                self.folder(&child.path(), &inner, depth + 1)?;
            } else if metadata.is_file() {
                self.entries.push(Entry {
                    shown: inner,
                    path: child.path(),
                    size: metadata.len(),
                    modified_ms: modified_ms(&metadata),
                });
            } else {
                self.skipped.push(Skipped {
                    path: inner,
                    reason: kind_reason(&metadata).into(),
                });
            }
        }
        Ok(())
    }
}

fn kind_reason(metadata: &Metadata) -> &'static str {
    if metadata.file_type().is_symlink() {
        "a link (links are not followed)"
    } else {
        "not a regular file (a device, socket or pipe)"
    }
}

/// Opens a walked file without following a link and without blocking on a
/// pipe, and checks it is still the regular file that was walked.
fn open(entry: &Entry) -> Result<File, UserError> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt as _;
        // FILE_FLAG_OPEN_REPARSE_POINT; FILE_SHARE_READ | FILE_SHARE_WRITE.
        options.custom_flags(0x0020_0000).share_mode(0x1 | 0x2);
    }
    let file = options
        .open(&entry.path)
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::PermissionDenied => denied(&entry.shown),
            _ => changed(&entry.shown),
        })?;
    let metadata = file.metadata().map_err(|_| changed(&entry.shown))?;
    if !metadata.is_file()
        || metadata.len() != entry.size
        || modified_ms(&metadata) != entry.modified_ms
    {
        return Err(changed(&entry.shown));
    }
    Ok(file)
}

fn changed(name: &str) -> UserError {
    UserError::new(
        UserFilesError::Changed,
        format!("{name} changed while it was downloading. Try again."),
    )
}

/// Streams `length` bytes of a walked file from `offset`, flow-controlled
/// by `credit`, each frame through `send`.
pub fn read(
    entry: &Entry,
    offset: u64,
    length: u64,
    credit: &Credit,
    stop: &AtomicBool,
    mut send: impl FnMut(Vec<u8>) -> bool,
) -> Result<UserFilesResult, UserError> {
    let mut file = open(entry)?;
    if offset > entry.size {
        return Err(UserError::invalid(format!(
            "{} is shorter than that.",
            entry.shown
        )));
    }
    file.seek(SeekFrom::Start(offset))
        .map_err(|_| changed(&entry.shown))?;
    let stopped = || UserError::new(UserFilesError::Io, "The download was stopped.");
    let mut left = length.min(entry.size - offset);
    let mut sent = 0u64;
    let mut buffer = vec![0u8; READ_FRAME_BYTES];
    while left > 0 {
        let Some(granted) = credit.take(left.min(READ_FRAME_BYTES as u64), stop) else {
            return Err(stopped());
        };
        let size = usize::try_from(granted).unwrap_or(READ_FRAME_BYTES);
        let read = file
            .read(&mut buffer[..size])
            .map_err(|_| changed(&entry.shown))?;
        if read == 0 {
            return Err(changed(&entry.shown));
        }
        if !send(buffer[..read].to_vec()) {
            return Err(stopped());
        }
        sent += read as u64;
        left -= read as u64;
        if (read as u64) < granted {
            credit.ack(granted - read as u64);
        }
    }
    let after = file.metadata().map_err(|_| changed(&entry.shown))?;
    if after.len() != entry.size || modified_ms(&after) != entry.modified_ms {
        return Err(changed(&entry.shown));
    }
    Ok(UserFilesResult::Read { bytes: sent })
}

#[cfg(all(test, unix))]
mod tests {
    use super::super::clipboard::fake::Fake;
    use super::*;

    fn offer_of(result: UserFilesResult) -> Option<Offer> {
        match result {
            UserFilesResult::Offered { offer } => offer,
            other => panic!("{other:?}"),
        }
    }

    /// SF22 and SF28: a copy is offered once with names and sizes, never
    /// paths; BMuster's own push is not offered; a new copy is a new offer;
    /// an hour ends it.
    #[test]
    fn sf22_copied_files_are_offered_once_without_paths() {
        let dir = tempfile::tempdir().unwrap();
        let report = dir.path().join("report.pdf");
        std::fs::write(&report, b"12345").unwrap();
        std::fs::create_dir(dir.path().join("Photos")).unwrap();
        let mut clipboard = Fake::default();
        let mut offers = Offers::default();
        let now = Instant::now();
        assert_eq!(offer_of(offers.look(&mut clipboard, now).unwrap()), None);
        *clipboard.held.lock().unwrap() = Some(vec![
            CopiedItem::Local(report.clone()),
            CopiedItem::Local(dir.path().join("Photos")),
        ]);
        let first = offer_of(offers.look(&mut clipboard, now).unwrap()).unwrap();
        assert_eq!(first.count, 2);
        assert_eq!(first.total_bytes, 5);
        assert_eq!(first.items[0].name, "report.pdf");
        assert_eq!(first.items[1].kind, OfferKind::Folder);
        assert_eq!(first.offer_id.len(), 32);
        let text = serde_json::to_string(&first).unwrap();
        assert!(
            !text.contains(&dir.path().to_string_lossy().into_owned()),
            "no paths"
        );
        // Looking again keeps the same offer.
        let again = offer_of(offers.look(&mut clipboard, now).unwrap()).unwrap();
        assert_eq!(again.offer_id, first.offer_id);
        // A new copy is a new offer; the old one is gone.
        *clipboard.held.lock().unwrap() = Some(vec![CopiedItem::Local(report.clone())]);
        let second = offer_of(offers.look(&mut clipboard, now).unwrap()).unwrap();
        assert_ne!(second.offer_id, first.offer_id);
        assert_eq!(
            offers.walk(&first.offer_id, now).unwrap_err().code,
            UserFilesError::Gone
        );
        // BMuster's own files are never offered back.
        offers.put_by_us(vec![report.clone()]);
        assert_eq!(offer_of(offers.look(&mut clipboard, now).unwrap()), None);
        // An hour ends an offer, and the same copy is not offered again.
        *clipboard.held.lock().unwrap() = Some(vec![CopiedItem::Local(dir.path().join("Photos"))]);
        let third = offer_of(offers.look(&mut clipboard, now).unwrap()).unwrap();
        let later = now + Duration::from_millis(OFFER_MAX_AGE_MS + 1);
        assert_eq!(
            offers.walk(&third.offer_id, later).unwrap_err().code,
            UserFilesError::Gone
        );
        assert_eq!(offer_of(offers.look(&mut clipboard, later).unwrap()), None);
        // Files not on this machine's disks.
        *clipboard.held.lock().unwrap() = Some(vec![CopiedItem::NotLocal]);
        let refused = offers.look(&mut clipboard, now).unwrap_err();
        assert_eq!(refused.code, UserFilesError::NotLocal);
        assert_eq!(
            refused.message,
            "These files are not on this machine's disks."
        );
    }

    /// SF24: links skipped, special files skipped without blocking, the
    /// person's own permissions, and a file changing during its read.
    #[test]
    fn sf24_reads_as_the_person_and_skips_what_is_not_a_file() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("Folder");
        std::fs::create_dir_all(folder.join("deep")).unwrap();
        std::fs::write(folder.join("a.txt"), b"hello").unwrap();
        std::fs::write(folder.join("deep/b.txt"), b"world!").unwrap();
        std::os::unix::fs::symlink("/etc/passwd", folder.join("link")).unwrap();
        let fifo =
            std::ffi::CString::new(folder.join("pipe").to_string_lossy().as_bytes()).unwrap();
        // SAFETY: a NUL-terminated path.
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        let mut clipboard = Fake::default();
        *clipboard.held.lock().unwrap() = Some(vec![CopiedItem::Local(folder.clone())]);
        let mut offers = Offers::default();
        let now = Instant::now();
        let offer = offer_of(offers.look(&mut clipboard, now).unwrap()).unwrap();
        let UserFilesResult::Walked {
            entries,
            skipped,
            single,
        } = offers.walk(&offer.offer_id, now).unwrap()
        else {
            panic!("not a walk");
        };
        assert!(!single);
        let paths: Vec<&str> = entries.iter().map(|entry| entry.path.as_str()).collect();
        assert_eq!(paths, ["Folder/a.txt", "Folder/deep/b.txt"]);
        let skipped: Vec<&str> = skipped.iter().map(|s| s.path.as_str()).collect();
        assert_eq!(skipped, ["Folder/link", "Folder/pipe"]);

        let entry = offers.entry(&offer.offer_id, 1, now).unwrap();
        let credit = Credit::default();
        let stop = AtomicBool::new(false);
        let mut got = Vec::new();
        read(&entry, 0, 100, &credit, &stop, |bytes| {
            got.extend(bytes);
            true
        })
        .unwrap();
        assert_eq!(got, b"world!");
        // Changed after the walk.
        std::fs::write(folder.join("deep/b.txt"), b"different length").unwrap();
        assert_eq!(
            read(&entry, 0, 100, &credit, &stop, |_| true)
                .unwrap_err()
                .code,
            UserFilesError::Changed
        );
        // A copied link at the top is not followed either.
        *clipboard.held.lock().unwrap() = Some(vec![CopiedItem::Local(folder.join("link"))]);
        let linked = offer_of(offers.look(&mut clipboard, now).unwrap());
        assert_eq!(linked, None, "a link is not offered");
        // A file the person cannot read is refused with their own permissions.
        let secret = dir.path().join("secret.txt");
        std::fs::write(&secret, b"x").unwrap();
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&secret, std::fs::Permissions::from_mode(0o000)).unwrap();
        // SAFETY: geteuid cannot fail.
        if unsafe { libc::geteuid() } != 0 {
            *clipboard.held.lock().unwrap() = Some(vec![CopiedItem::Local(secret.clone())]);
            let offer = offer_of(offers.look(&mut clipboard, now).unwrap()).unwrap();
            offers.walk(&offer.offer_id, now).unwrap();
            let entry = offers.entry(&offer.offer_id, 0, now).unwrap();
            let refused = read(&entry, 0, 1, &credit, &stop, |_| true).unwrap_err();
            assert_eq!(refused.code, UserFilesError::Denied);
            assert_eq!(
                refused.message,
                "You don't have permission to read secret.txt on the machine."
            );
        }
    }
}
