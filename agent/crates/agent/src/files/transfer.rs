//! Reading a file from an offset (downloads) and writing one in chunks
//! (uploads) (SPEC-FILES F5, F6).
//!
//! An upload goes to `<name>.bmuster-part` beside where it ends up, so a
//! dropped connection loses nothing: `write-begin` says how much the part
//! file already holds and the browser carries on from there. `write-end`
//! checks the size and SHA-256 before renaming it into place. The part file
//! is never opened through a link, so nobody can point an upload elsewhere.

use super::paths::{check_path, child, display, NameUse, HOST};
use super::roots::space;
use super::FileError;
use bmuster_protocol::files::{ErrorCode, FilesResult, PART_SUFFIX, READ_FRAME_BYTES, READ_WINDOW};
use sha2::{Digest as _, Sha256};
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::io::{Read as _, Seek as _, SeekFrom, Write as _};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

/// A read with no acknowledgement this long has been abandoned.
const ACK_WAIT: Duration = Duration::from_secs(120);

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// How far one read may run ahead of the server (flow control per read).
pub struct Credit {
    state: Mutex<CreditState>,
    wake: Condvar,
}

struct CreditState {
    allowed: u64,
    cancelled: bool,
}

impl Default for Credit {
    fn default() -> Self {
        Self {
            state: Mutex::new(CreditState {
                allowed: READ_WINDOW,
                cancelled: false,
            }),
            wake: Condvar::new(),
        }
    }
}

impl Credit {
    /// The server passed on `bytes` more.
    pub fn ack(&self, bytes: u64) {
        let mut state = lock(&self.state);
        state.allowed = state.allowed.saturating_add(bytes).min(2 * READ_WINDOW);
        self.wake.notify_all();
    }

    pub fn cancel(&self) {
        lock(&self.state).cancelled = true;
        self.wake.notify_all();
    }

    /// Up to `want` bytes the read may send now; waits for an ack when it
    /// may send none. None: cancelled, stopped, or the server went quiet.
    fn take(&self, want: u64, stop: &AtomicBool) -> Option<u64> {
        let until = Instant::now() + ACK_WAIT;
        let mut state = lock(&self.state);
        loop {
            if state.cancelled || stop.load(Ordering::SeqCst) || Instant::now() > until {
                return None;
            }
            if state.allowed > 0 {
                let granted = want.min(state.allowed);
                state.allowed -= granted;
                return Some(granted);
            }
            state = self
                .wake
                .wait_timeout(state, Duration::from_millis(200))
                .map(|(guard, _)| guard)
                .unwrap_or_else(|poisoned| poisoned.into_inner().0);
        }
    }
}

/// Sends `length` bytes of `path` from `offset` (fewer at the end), each
/// frame through `send`, which says false once nobody is listening.
pub fn read(
    path: &str,
    offset: u64,
    length: u64,
    credit: &Credit,
    stop: &AtomicBool,
    mut send: impl FnMut(Vec<u8>) -> bool,
) -> Result<FilesResult, FileError> {
    let file_path = check_path(HOST, path)?;
    let mut file = File::open(&file_path).map_err(|e| FileError::io(&e, path))?;
    let metadata = file.metadata().map_err(|e| FileError::io(&e, path))?;
    if !metadata.is_file() {
        return Err(FileError::invalid(format!("{path} is not a file.")));
    }
    if offset > metadata.len() {
        return Err(FileError::invalid(format!(
            "{path} is only {} bytes long.",
            metadata.len()
        )));
    }
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| FileError::io(&e, path))?;
    let mut left = length;
    let mut sent = 0u64;
    let mut buffer = vec![0u8; READ_FRAME_BYTES];
    while left > 0 {
        let want = left.min(READ_FRAME_BYTES as u64);
        let Some(granted) = credit.take(want, stop) else {
            return Err(FileError::new(
                ErrorCode::Io,
                "The download was stopped.".into(),
            ));
        };
        let size = usize::try_from(granted).unwrap_or(READ_FRAME_BYTES);
        let read = file
            .read(&mut buffer[..size])
            .map_err(|e| FileError::io(&e, path))?;
        if read == 0 {
            break;
        }
        if !send(buffer[..read].to_vec()) {
            return Err(FileError::new(
                ErrorCode::Io,
                "The session closed during the download.".into(),
            ));
        }
        sent += read as u64;
        left -= read as u64;
        if (read as u64) < granted {
            credit.ack(granted - read as u64);
        }
    }
    Ok(FilesResult::Read { bytes: sent })
}

/// Part files being written right now: one chunk at a time per file.
static WRITING: Mutex<Option<HashSet<PathBuf>>> = Mutex::new(None);

/// Holds a part file for one chunk; let go when dropped.
struct Writing(PathBuf);

impl Writing {
    fn claim(part: &Path) -> Result<Self, FileError> {
        let mut writing = lock(&WRITING);
        let held = writing.get_or_insert_with(HashSet::new);
        if !held.insert(part.to_path_buf()) {
            return Err(FileError::new(
                ErrorCode::Busy,
                format!("{} is being written already.", display(part)),
            ));
        }
        Ok(Self(part.to_path_buf()))
    }
}

impl Drop for Writing {
    fn drop(&mut self) {
        if let Some(held) = lock(&WRITING).as_mut() {
            held.remove(&self.0);
        }
    }
}

/// The finished file's path and its part file's.
fn upload_paths(dir: &str, name: &str) -> Result<(PathBuf, PathBuf), FileError> {
    let target = child(HOST, dir, name, NameUse::New)?;
    let part = child(HOST, dir, &format!("{name}{PART_SUFFIX}"), NameUse::New)?;
    Ok((target, part))
}

/// The part file's length; 0 when there is none. A link where the part file
/// should be is removed, never written through.
fn part_size(part: &Path) -> Result<u64, FileError> {
    match fs::symlink_metadata(part) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            fs::remove_file(part).map_err(|e| FileError::io(&e, &display(part)))?;
            Ok(0)
        }
        Ok(metadata) if metadata.is_file() => Ok(metadata.len()),
        Ok(_) => Err(FileError::new(
            ErrorCode::Exists,
            format!("{} is in the way of the upload.", display(part)),
        )),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(0),
        Err(e) => Err(FileError::io(&e, &display(part))),
    }
}

/// Opens the part file for writing without following a link.
fn open_part(part: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.create(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt as _;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    options.open(part)
}

/// Starts or resumes an upload of `size` bytes: how much is already there.
pub fn begin(dir: &str, name: &str, size: u64, replace: bool) -> Result<FilesResult, FileError> {
    let (target, part) = upload_paths(dir, name)?;
    let folder = check_path(HOST, dir)?;
    match fs::metadata(&folder) {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => return Err(FileError::invalid(format!("{dir} is not a folder."))),
        Err(e) => return Err(FileError::io(&e, dir)),
    }
    match fs::symlink_metadata(&target) {
        Ok(metadata) if metadata.is_dir() => {
            return Err(FileError::new(
                ErrorCode::Exists,
                format!("{} is a folder.", display(&target)),
            ))
        }
        Ok(_) if !replace => {
            return Err(FileError::new(
                ErrorCode::Exists,
                format!("{} already exists.", display(&target)),
            ))
        }
        _ => {}
    }
    let mut have = part_size(&part)?;
    if have > size {
        fs::remove_file(&part).map_err(|e| FileError::io(&e, &display(&part)))?;
        have = 0;
    }
    if let Some((_, free)) = space(&folder) {
        if size - have > free {
            return Err(FileError::new(
                ErrorCode::NoSpace,
                format!(
                    "{dir} has {free} bytes free; the upload needs {} more.",
                    size - have
                ),
            ));
        }
    }
    // The part file exists from the start, so an empty upload has one to finish.
    open_part(&part).map_err(|e| FileError::io(&e, &display(&part)))?;
    Ok(FilesResult::Part { part_size: have })
}

/// Appends one chunk at `offset`, which must be where the part file ends.
pub fn chunk(dir: &str, name: &str, offset: u64, data: &[u8]) -> Result<FilesResult, FileError> {
    let (_, part) = upload_paths(dir, name)?;
    let _writing = Writing::claim(&part)?;
    let have = part_size(&part)?;
    if offset != have {
        return Err(FileError::new(
            ErrorCode::Offset,
            format!("The upload is at {have} bytes, not {offset}."),
        ));
    }
    let shown = display(&part);
    let mut file = open_part(&part).map_err(|e| FileError::io(&e, &shown))?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| FileError::io(&e, &shown))?;
    file.write_all(data)
        .map_err(|e| FileError::io(&e, &shown))?;
    file.flush().map_err(|e| FileError::io(&e, &shown))?;
    Ok(FilesResult::Part {
        part_size: offset + data.len() as u64,
    })
}

fn sha256_of(path: &Path) -> std::io::Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            return Ok(hex::encode(hasher.finalize()));
        }
        hasher.update(&buffer[..read]);
    }
}

/// Checks the finished part file and renames it into place.
pub fn end(dir: &str, name: &str, size: u64, sha256: &str) -> Result<FilesResult, FileError> {
    let (target, part) = upload_paths(dir, name)?;
    let _writing = Writing::claim(&part)?;
    let have = part_size(&part)?;
    if have != size {
        return Err(FileError::new(
            ErrorCode::Mismatch,
            format!("The upload has {have} of {size} bytes."),
        ));
    }
    let shown = display(&part);
    let actual = sha256_of(&part).map_err(|e| FileError::io(&e, &shown))?;
    if !actual.eq_ignore_ascii_case(sha256) {
        let _ = fs::remove_file(&part);
        return Err(FileError::new(
            ErrorCode::Mismatch,
            "The file arrived changed (its SHA-256 differs), so it was thrown away. Send it again."
                .into(),
        ));
    }
    fs::rename(&part, &target).map_err(|e| FileError::io(&e, &display(&target)))?;
    Ok(FilesResult::Written {
        path: display(&target),
        size,
        sha256: actual,
    })
}

/// Gives up an upload: its part file goes.
pub fn cancel(dir: &str, name: &str) -> Result<FilesResult, FileError> {
    let (_, part) = upload_paths(dir, name)?;
    let _writing = Writing::claim(&part)?;
    match fs::remove_file(&part) {
        Ok(()) => Ok(FilesResult::Nothing {}),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(FilesResult::Nothing {}),
        Err(e) => Err(FileError::io(&e, &display(&part))),
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn text(path: &Path) -> String {
        display(path)
    }

    fn hex_sha(bytes: &[u8]) -> String {
        hex::encode(Sha256::digest(bytes))
    }

    fn read_all(path: &Path, offset: u64, length: u64) -> (Vec<u8>, u64) {
        let credit = Credit::default();
        let stop = AtomicBool::new(false);
        let mut got = Vec::new();
        let FilesResult::Read { bytes } = read(&text(path), offset, length, &credit, &stop, |b| {
            got.extend_from_slice(&b);
            credit.ack(b.len() as u64);
            true
        })
        .unwrap() else {
            panic!("not a read")
        };
        (got, bytes)
    }

    #[test]
    fn reads_start_at_the_offset_and_stop_at_the_end() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("data.bin");
        let data: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
        fs::write(&path, &data).unwrap();
        let (got, bytes) = read_all(&path, 0, u64::MAX);
        assert_eq!(got, data);
        assert_eq!(bytes, data.len() as u64);
        let (got, _) = read_all(&path, 123_456, 1000);
        assert_eq!(got, &data[123_456..124_456]);
        let (got, _) = read_all(&path, 299_990, 1000);
        assert_eq!(got, &data[299_990..]);
        let credit = Credit::default();
        let stop = AtomicBool::new(false);
        let past = read(&text(&path), 400_000, 1, &credit, &stop, |_| true).unwrap_err();
        assert_eq!(past.code, ErrorCode::Invalid);
        let folder = read(&text(dir.path()), 0, 1, &credit, &stop, |_| true).unwrap_err();
        assert_eq!(folder.code, ErrorCode::Invalid);
    }

    #[test]
    fn a_read_waits_for_acks_and_stops_when_cancelled() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.bin");
        fs::write(&path, vec![7u8; (READ_WINDOW * 3) as usize]).unwrap();
        let credit = Arc::new(Credit::default());
        let sent = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let reader = {
            let (credit, sent, path) = (Arc::clone(&credit), Arc::clone(&sent), text(&path));
            std::thread::spawn(move || {
                let stop = AtomicBool::new(false);
                read(&path, 0, u64::MAX, &credit, &stop, |b| {
                    sent.fetch_add(b.len() as u64, Ordering::SeqCst);
                    true
                })
            })
        };
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(
            sent.load(Ordering::SeqCst),
            READ_WINDOW,
            "stops at the window"
        );
        credit.ack(1024 * 1024);
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(sent.load(Ordering::SeqCst), READ_WINDOW + 1024 * 1024);
        credit.cancel();
        assert!(reader.join().unwrap().is_err());
    }

    #[test]
    fn an_upload_resumes_from_its_part_file_and_checks_its_hash() {
        let dir = tempfile::tempdir().unwrap();
        let base = text(dir.path());
        let data: Vec<u8> = (0..1000u32).map(|i| (i % 256) as u8).collect();
        let size = data.len() as u64;
        assert_eq!(
            begin(&base, "a.bin", size, false).unwrap(),
            FilesResult::Part { part_size: 0 }
        );
        chunk(&base, "a.bin", 0, &data[..400]).unwrap();
        // The connection drops; the browser asks again and carries on.
        assert_eq!(
            begin(&base, "a.bin", size, false).unwrap(),
            FilesResult::Part { part_size: 400 }
        );
        assert_eq!(
            chunk(&base, "a.bin", 0, &data[..400]).unwrap_err().code,
            ErrorCode::Offset,
            "a chunk must start where the part file ends"
        );
        chunk(&base, "a.bin", 400, &data[400..]).unwrap();
        assert!(dir.path().join("a.bin.bmuster-part").exists());
        assert_eq!(
            end(&base, "a.bin", size, &hex_sha(&data)).unwrap(),
            FilesResult::Written {
                path: text(&dir.path().join("a.bin")),
                size,
                sha256: hex_sha(&data)
            }
        );
        assert_eq!(fs::read(dir.path().join("a.bin")).unwrap(), data);
        assert!(!dir.path().join("a.bin.bmuster-part").exists());
        assert_eq!(
            begin(&base, "a.bin", size, false).unwrap_err().code,
            ErrorCode::Exists
        );
        assert!(begin(&base, "a.bin", size, true).is_ok());
    }

    #[test]
    fn an_empty_file_uploads() {
        let dir = tempfile::tempdir().unwrap();
        let base = text(dir.path());
        begin(&base, "empty.txt", 0, false).unwrap();
        end(&base, "empty.txt", 0, &hex_sha(b"")).unwrap();
        assert_eq!(fs::read(dir.path().join("empty.txt")).unwrap(), b"");
    }

    #[test]
    fn a_changed_upload_is_thrown_away() {
        let dir = tempfile::tempdir().unwrap();
        let base = text(dir.path());
        begin(&base, "b.bin", 4, false).unwrap();
        chunk(&base, "b.bin", 0, b"abcd").unwrap();
        assert_eq!(
            end(&base, "b.bin", 5, &hex_sha(b"abcd")).unwrap_err().code,
            ErrorCode::Mismatch
        );
        assert_eq!(
            end(&base, "b.bin", 4, &hex_sha(b"abcX")).unwrap_err().code,
            ErrorCode::Mismatch
        );
        assert!(!dir.path().join("b.bin").exists());
        assert!(!dir.path().join("b.bin.bmuster-part").exists());
    }

    #[test]
    fn cancel_removes_the_part_and_a_planted_link_is_never_written_through() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let victim = outside.path().join("victim");
        fs::write(&victim, b"original").unwrap();
        let base = text(dir.path());
        std::os::unix::fs::symlink(&victim, dir.path().join("c.bin.bmuster-part")).unwrap();
        assert_eq!(
            begin(&base, "c.bin", 3, false).unwrap(),
            FilesResult::Part { part_size: 0 }
        );
        // Planted again between two requests.
        fs::remove_file(dir.path().join("c.bin.bmuster-part")).unwrap();
        std::os::unix::fs::symlink(&victim, dir.path().join("c.bin.bmuster-part")).unwrap();
        chunk(&base, "c.bin", 0, b"new").unwrap();
        assert_eq!(fs::read(&victim).unwrap(), b"original");
        cancel(&base, "c.bin").unwrap();
        assert!(fs::symlink_metadata(dir.path().join("c.bin.bmuster-part")).is_err());
        assert_eq!(cancel(&base, "c.bin").unwrap(), FilesResult::Nothing {});
    }

    #[test]
    fn an_upload_that_does_not_fit_is_refused_at_the_start() {
        let dir = tempfile::tempdir().unwrap();
        let error = begin(&text(dir.path()), "huge.bin", u64::MAX / 2, false).unwrap_err();
        assert_eq!(error.code, ErrorCode::NoSpace);
    }
}
