//! Saving sent files (SPEC-SESSION-FILES 4.3, SF8–SF10), in the helper,
//! as the person, inside the opened Downloads/BMuster folder.
//!
//! Each file is first a part file named after its transfer id (never after
//! anything the browser chose), made with `O_CREAT | O_EXCL | O_NOFOLLOW`
//! and written at its end only, so a dropped connection resumes from what
//! the machine holds. At the end its size and SHA-256 must be what the
//! browser sent; then it is renamed to the first free name with a rename
//! that never replaces (`renameat2(RENAME_NOREPLACE)`, or `MoveFileExW`
//! without replacing), trying " (2)", " (3)" … so a file that appears
//! meanwhile is never overwritten.

use super::folder::Folder;
use super::names;
use super::UserError;
use bmuster_protocol::files::PART_SUFFIX;
use bmuster_protocol::user_files::{UserFilesError, UserFilesResult, KEEP_FREE_BYTES};
use sha2::{Digest as _, Sha256};
use std::collections::HashMap;
use std::io::{self, Read as _, Seek as _, SeekFrom, Write as _};
use std::time::{Duration, SystemTime};

/// Part files left this long are removed when the helper starts.
pub const PART_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);

/// A transfer the server named: its id is all a part file's name holds.
fn part_name(transfer_id: &str) -> Result<String, UserError> {
    let fine = !transfer_id.is_empty()
        && transfer_id.len() <= 64
        && transfer_id
            .chars()
            .all(|c| c.is_ascii_hexdigit() || c == '-');
    if fine {
        Ok(format!("{transfer_id}{PART_SUFFIX}"))
    } else {
        Err(UserError::invalid(
            "That transfer id is not one BMuster made.",
        ))
    }
}

/// The size of a byte count for people (`12 GB`).
pub fn size_text(bytes: u64) -> String {
    const GB: f64 = 1024.0 * 1024.0 * 1024.0;
    const MB: f64 = 1024.0 * 1024.0;
    let value = bytes as f64;
    if value >= GB {
        format!("{:.1} GB", value / GB)
    } else if value >= MB {
        format!("{:.1} MB", value / MB)
    } else {
        format!("{bytes} bytes")
    }
}

/// One file being sent.
struct Send {
    name: String,
    size: u64,
}

/// The sends of one helper.
pub struct Sends {
    folder: Folder,
    running: HashMap<String, Send>,
    /// What each finished transfer was saved as, for the batch's notice.
    saved: HashMap<String, String>,
}

impl Sends {
    /// Takes the opened folder and removes part files older than a day.
    pub fn new(folder: Folder, now: SystemTime) -> Self {
        sweep(&folder, now);
        Self {
            folder,
            running: HashMap::new(),
            saved: HashMap::new(),
        }
    }

    pub fn folder(&self) -> &Folder {
        &self.folder
    }

    fn failed(&self, error: &io::Error, name: &str) -> UserError {
        UserError::io(error, name, &self.folder.user, &self.folder.label)
    }

    fn part_size(&self, part: &str) -> io::Result<Option<u64>> {
        match self.folder.open_existing(part, false) {
            Ok(file) => Ok(Some(file.metadata()?.len())),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// Starts or resumes a file: the name, then the room left.
    pub fn begin(
        &mut self,
        transfer_id: &str,
        name: &str,
        size: u64,
    ) -> Result<UserFilesResult, UserError> {
        names::check(name)?;
        let part = part_name(transfer_id)?;
        let held = match self.part_size(&part).map_err(|e| self.failed(&e, name))? {
            Some(held) if held <= size => held,
            Some(_) => {
                self.folder
                    .remove(&part)
                    .map_err(|e| self.failed(&e, name))?;
                0
            }
            None => 0,
        };
        let free = self.folder.free().map_err(|e| self.failed(&e, name))?;
        let needed = size - held;
        if free < needed.saturating_add(KEEP_FREE_BYTES) {
            return Err(UserError::new(
                UserFilesError::NoSpace,
                format!(
                    "There isn't enough room on the machine: {} free, {name} needs {} and 1 GB must stay free.",
                    size_text(free),
                    size_text(needed)
                ),
            ));
        }
        if held == 0 && self.part_size(&part).ok().flatten().is_none() {
            drop(
                self.folder
                    .create(&part)
                    .map_err(|e| self.failed(&e, name))?,
            );
        }
        self.running.insert(
            transfer_id.to_string(),
            Send {
                name: name.to_string(),
                size,
            },
        );
        Ok(UserFilesResult::Part { part_size: held })
    }

    fn running(&self, transfer_id: &str) -> Result<&Send, UserError> {
        self.running
            .get(transfer_id)
            .ok_or_else(|| UserError::invalid("That file was not started; start it again."))
    }

    /// Appends at the part file's end, which must be `offset`.
    pub fn chunk(
        &mut self,
        transfer_id: &str,
        offset: u64,
        data: &[u8],
    ) -> Result<UserFilesResult, UserError> {
        let send = self.running(transfer_id)?;
        let part = part_name(transfer_id)?;
        let mut file = self
            .folder
            .open_existing(&part, true)
            .map_err(|e| self.failed(&e, &send.name))?;
        let held = file
            .seek(SeekFrom::End(0))
            .map_err(|e| self.failed(&e, &send.name))?;
        if held != offset {
            return Err(UserError::new(
                UserFilesError::Offset,
                format!("The machine holds {held} bytes, not {offset}."),
            ));
        }
        if held + data.len() as u64 > send.size {
            return Err(UserError::invalid("More was sent than the file's size."));
        }
        if let Err(e) = file.write_all(data).and_then(|()| file.flush()) {
            // A full disk keeps what it held before this piece.
            let _ = file.set_len(held);
            return Err(self.failed(&e, &send.name));
        }
        Ok(UserFilesResult::Part {
            part_size: held + data.len() as u64,
        })
    }

    /// Checks the whole file, then saves it under the first free name.
    pub fn end(
        &mut self,
        transfer_id: &str,
        size: u64,
        sha256: &str,
    ) -> Result<UserFilesResult, UserError> {
        let send = self.running(transfer_id)?;
        let name = send.name.clone();
        let part = part_name(transfer_id)?;
        let mut file = self
            .folder
            .open_existing(&part, false)
            .map_err(|e| self.failed(&e, &name))?;
        let mut hasher = Sha256::new();
        let mut buffer = vec![0u8; 1024 * 1024];
        let mut total = 0u64;
        loop {
            let read = file.read(&mut buffer).map_err(|e| self.failed(&e, &name))?;
            if read == 0 {
                break;
            }
            hasher.update(&buffer[..read]);
            total += read as u64;
        }
        let digest = hex::encode(hasher.finalize());
        if total != size || total != send.size || !digest.eq_ignore_ascii_case(sha256) {
            let _ = self.folder.remove(&part);
            self.running.remove(transfer_id);
            return Err(UserError::new(
                UserFilesError::Mismatch,
                format!("{name} arrived changed on the way. Send it again."),
            ));
        }
        Folder::make_private(&file).map_err(|e| self.failed(&e, &name))?;
        drop(file);
        let saved_as = self.rename_free(&part, &name)?;
        self.running.remove(transfer_id);
        self.saved.insert(transfer_id.to_string(), saved_as.clone());
        Ok(UserFilesResult::Saved {
            saved_as,
            size: total,
            sha256: digest,
        })
    }

    /// Renames the part file to `name`, or `name (2)` … without replacing.
    fn rename_free(&self, part: &str, name: &str) -> Result<String, UserError> {
        for n in 1..=names::MAX_NUMBER {
            let candidate = names::numbered(name, n);
            match self.folder.rename_new(part, &candidate) {
                Ok(()) => return Ok(candidate),
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(self.failed(&e, name)),
            }
        }
        Err(UserError::new(
            UserFilesError::Io,
            format!(
                "There are already {} files called {name}; rename some of them.",
                names::MAX_NUMBER
            ),
        ))
    }

    /// Removes the part file (nothing already saved is touched).
    pub fn cancel(&mut self, transfer_id: &str) -> Result<UserFilesResult, UserError> {
        let part = part_name(transfer_id)?;
        self.running.remove(transfer_id);
        match self.folder.remove(&part) {
            Ok(()) => Ok(UserFilesResult::Empty {}),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(UserFilesResult::Empty {}),
            Err(e) => Err(self.failed(&e, "the unfinished file")),
        }
    }

    /// The names the transfers were saved as, in order; unknown ids are left out.
    pub fn saved_names(&self, transfer_ids: &[String]) -> Vec<String> {
        transfer_ids
            .iter()
            .filter_map(|id| self.saved.get(id).cloned())
            .collect()
    }
}

/// Removes part files older than [`PART_MAX_AGE`].
fn sweep(folder: &Folder, now: SystemTime) {
    let Ok(names) = folder.names() else {
        return;
    };
    for name in names.iter().filter(|name| name.ends_with(PART_SUFFIX)) {
        let old = folder
            .open_existing(name, false)
            .and_then(|file| file.metadata())
            .and_then(|metadata| metadata.modified())
            .is_ok_and(|modified| {
                now.duration_since(modified)
                    .is_ok_and(|age| age > PART_MAX_AGE)
            });
        if old {
            let _ = folder.remove(name);
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::path::Path;

    const ID: &str = "0b5c2d6e-1111-4222-8333-444455556666";

    fn sha(data: &[u8]) -> String {
        hex::encode(Sha256::digest(data))
    }

    fn sends(downloads: &Path) -> Sends {
        let folder = Folder::open(downloads, "Downloads/BMuster".into(), "Kim".into()).unwrap();
        Sends::new(folder, SystemTime::now())
    }

    fn send(sends: &mut Sends, id: &str, name: &str, data: &[u8]) -> String {
        sends.begin(id, name, data.len() as u64).unwrap();
        sends.chunk(id, 0, data).unwrap();
        match sends.end(id, data.len() as u64, &sha(data)).unwrap() {
            UserFilesResult::Saved { saved_as, .. } => saved_as,
            other => panic!("{other:?}"),
        }
    }

    /// SF7 (the rename): clashes are numbered, nothing is ever replaced.
    #[test]
    fn sf7_saved_names_never_replace() {
        let dir = tempfile::tempdir().unwrap();
        let mut sends = sends(dir.path());
        let bm = dir.path().join("BMuster");
        std::fs::write(bm.join("report.pdf"), b"theirs").unwrap();
        assert_eq!(send(&mut sends, ID, "report.pdf", b"one"), "report (2).pdf");
        let other = "0b5c2d6e-1111-4222-8333-444455556667";
        assert_eq!(
            send(&mut sends, other, "report.pdf", b"two"),
            "report (3).pdf"
        );
        assert_eq!(std::fs::read(bm.join("report.pdf")).unwrap(), b"theirs");
        assert_eq!(std::fs::read(bm.join("report (2).pdf")).unwrap(), b"one");
        assert_eq!(
            sends.saved_names(&[ID.into(), "x".into(), other.into()]),
            ["report (2).pdf", "report (3).pdf"]
        );
    }

    /// SF8: saved files belong to the person, the folder 0700, files 0600.
    #[test]
    fn sf8_files_are_the_persons() {
        use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};
        let dir = tempfile::tempdir().unwrap();
        let mut sends = sends(dir.path());
        let saved = send(&mut sends, ID, "a.txt", b"hello");
        let file = std::fs::metadata(dir.path().join("BMuster").join(saved)).unwrap();
        // SAFETY: geteuid cannot fail.
        let me = unsafe { libc::geteuid() };
        assert_eq!(file.uid(), me);
        assert_eq!(file.permissions().mode() & 0o777, 0o600);
        let folder = std::fs::metadata(dir.path().join("BMuster")).unwrap();
        assert_eq!(folder.permissions().mode() & 0o777, 0o700);
    }

    /// SF9: the room left is checked before anything is written.
    #[test]
    fn sf9_limits_and_full_disks() {
        let dir = tempfile::tempdir().unwrap();
        let mut sends = sends(dir.path());
        let free = sends.folder().free().unwrap();
        let refused = sends.begin(ID, "huge.iso", free).unwrap_err();
        assert_eq!(refused.code, UserFilesError::NoSpace);
        assert!(
            refused
                .message
                .starts_with("There isn't enough room on the machine: "),
            "{}",
            refused.message
        );
        assert!(refused.message.ends_with("and 1 GB must stay free."));
        assert_eq!(
            std::fs::read_dir(dir.path().join("BMuster"))
                .unwrap()
                .count(),
            0
        );
        let disk_full = UserError::io(
            &io::Error::from_raw_os_error(libc::ENOSPC),
            "a.pdf",
            "Kim",
            "Downloads/BMuster",
        );
        assert_eq!(disk_full.code, UserFilesError::NoSpace);
        assert_eq!(
            disk_full.message,
            "The machine's disk filled up while saving a.pdf."
        );
        let quota = UserError::io(
            &io::Error::from_raw_os_error(libc::EDQUOT),
            "a.pdf",
            "Kim",
            "Downloads/BMuster",
        );
        assert_eq!(quota.code, UserFilesError::Quota);
        assert_eq!(
            quota.message,
            "Kim is over their disk quota on the machine."
        );
        let denied = UserError::io(
            &io::Error::from_raw_os_error(libc::EACCES),
            "a.pdf",
            "Kim",
            "Downloads/BMuster",
        );
        assert_eq!(denied.code, UserFilesError::Denied);
        assert_eq!(
            denied.message,
            "BMuster couldn't write to Kim's Downloads/BMuster folder: permission denied."
        );
        assert_eq!(
            sends.begin("../x", "a", 1).unwrap_err().code,
            UserFilesError::Invalid
        );
    }

    /// SF10: resume, the end check, cancel and the day-old sweep.
    #[test]
    fn sf10_resume_check_and_cancel() {
        let dir = tempfile::tempdir().unwrap();
        let bm = dir.path().join("BMuster");
        let mut sends = sends(dir.path());
        sends.begin(ID, "a.bin", 6).unwrap();
        sends.chunk(ID, 0, b"abc").unwrap();
        // The connection dropped: begin again says what the machine holds.
        assert_eq!(
            sends.begin(ID, "a.bin", 6).unwrap(),
            UserFilesResult::Part { part_size: 3 }
        );
        assert_eq!(
            sends.chunk(ID, 1, b"x").unwrap_err().code,
            UserFilesError::Offset
        );
        sends.chunk(ID, 3, b"def").unwrap();
        assert_eq!(
            sends.end(ID, 6, &sha(b"abcdeX")).unwrap_err().code,
            UserFilesError::Mismatch
        );
        assert_eq!(
            std::fs::read_dir(&bm).unwrap().count(),
            0,
            "the bad part is gone"
        );
        sends.begin(ID, "b.bin", 3).unwrap();
        sends.chunk(ID, 0, b"abc").unwrap();
        sends.cancel(ID).unwrap();
        assert_eq!(std::fs::read_dir(&bm).unwrap().count(), 0);
        // A part file from yesterday goes when the next helper starts; today's stays.
        std::fs::write(bm.join(format!("{ID}{PART_SUFFIX}")), b"old").unwrap();
        let fresh = format!("0b5c2d6e-1111-4222-8333-444455550000{PART_SUFFIX}");
        std::fs::write(bm.join(&fresh), b"new").unwrap();
        let later = SystemTime::now() + PART_MAX_AGE + Duration::from_secs(60);
        drop(sends);
        let folder = Folder::open(dir.path(), "Downloads/BMuster".into(), "Kim".into()).unwrap();
        std::fs::File::options()
            .write(true)
            .open(bm.join(&fresh))
            .unwrap()
            .set_modified(later)
            .unwrap();
        let _sends = Sends::new(folder, later);
        let left: Vec<_> = std::fs::read_dir(&bm)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(left, [fresh]);
    }
}
