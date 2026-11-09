//! The updater's files. It runs as root (or SYSTEM) but the data folder
//! belongs to the service account, which a compromised app controls; so in
//! the data folder it never follows a link, never reads the request flag,
//! reads only bounded files and replaces files with a rename. Its own
//! records live in the program folder, which only root can write.

use crate::layout::Layout;
use crate::releases::checked_version;
use anyhow::{bail, Context as _, Result};
use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_SMALL_FILE: u64 = 32 * 1024;

/// Refuses a data folder that is a link: the updater writes into it.
pub fn check_data_dir(data: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(data)
        .with_context(|| format!("there is no data folder {}", data.display()))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        bail!(
            "{} is a link or not a folder; the updater refuses to follow it",
            data.display()
        );
    }
    Ok(())
}

/// Removes the request flag without opening it; true when there was one.
/// Its contents never matter.
pub fn take_flag(flag: &Path) -> Result<bool> {
    match fs::symlink_metadata(flag) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e).with_context(|| format!("could not look at {}", flag.display())),
        Ok(metadata) if metadata.is_file() || metadata.file_type().is_symlink() => {
            fs::remove_file(flag)
                .with_context(|| format!("could not remove {}", flag.display()))?;
            Ok(true)
        }
        Ok(_) => bail!(
            "{} is not a file; remove it to request updates again",
            flag.display()
        ),
    }
}

fn no_follow(options: &mut OpenOptions) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt as _;
        // FILE_FLAG_OPEN_REPARSE_POINT: open a link itself, never its target.
        options.custom_flags(0x0020_0000);
    }
}

/// Opens an existing regular file without following a link.
pub fn open_no_follow(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    no_follow(&mut options);
    let file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(std::io::Error::other(format!(
            "{} is not a regular file",
            path.display()
        )));
    }
    Ok(file)
}

/// A small file's bytes, without following a link; `None` when absent.
pub fn read_small(path: &Path) -> Result<Option<Vec<u8>>> {
    let file = match open_no_follow(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e).with_context(|| format!("could not read {}", path.display())),
    };
    let mut bytes = Vec::new();
    file.take(MAX_SMALL_FILE + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_SMALL_FILE {
        bail!("{} is larger than {MAX_SMALL_FILE} bytes", path.display());
    }
    Ok(Some(bytes))
}

/// Removes a file or link; nothing when absent.
pub fn remove(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
            Err(e).with_context(|| format!("could not remove {}", path.display()))
        }
        _ => Ok(()),
    }
}

/// A new file only this call created (an existing name or link is removed
/// first, never followed).
fn create_fresh(path: &Path, mode: u32) -> Result<File> {
    remove(path)?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    no_follow(&mut options);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(mode);
    }
    #[cfg(not(unix))]
    let _ = mode;
    options
        .open(path)
        .with_context(|| format!("could not create {}", path.display()))
}

/// Writes `bytes` beside `path` and renames it over `path`: readers see the
/// old file or the new one, and a link at `path` is replaced, not followed.
pub fn write_atomic(path: &Path, bytes: &[u8], mode: u32) -> Result<()> {
    let Some(name) = path.file_name() else {
        bail!("{} has no file name", path.display());
    };
    let mut staged_name = name.to_os_string();
    staged_name.push(".new");
    let staged = path.with_file_name(staged_name);
    let mut file = create_fresh(&staged, mode)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    replace(&staged, path)
}

#[cfg(not(windows))]
fn replace(from: &Path, to: &Path) -> Result<()> {
    fs::rename(from, to)
        .with_context(|| format!("could not move {} to {}", from.display(), to.display()))?;
    if let Some(parent) = to.parent() {
        File::open(parent)?.sync_all()?;
    }
    Ok(())
}

#[cfg(windows)]
fn replace(from: &Path, to: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt as _;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    let from_wide: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to_wide: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    // SAFETY: both strings are NUL-terminated UTF-16 and outlive the call.
    let moved = unsafe {
        MoveFileExW(
            from_wide.as_ptr(),
            to_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        return Err(std::io::Error::last_os_error())
            .with_context(|| format!("could not move {} to {}", from.display(), to.display()));
    }
    Ok(())
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| {
            u64::try_from(since.as_millis()).unwrap_or(u64::MAX)
        })
}

// ---------------------------------------------------------------------------
// Progress, for the app
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    Checking,
    UpToDate,
    Downloading,
    Switching,
    Starting,
    Healthy,
    RolledBack,
    Failed,
}

/// `update-status.json`: written only by the updater, read by the app.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Status {
    pub phase: Phase,
    pub from: Option<String>,
    pub to: Option<String>,
    pub message: String,
    pub at_ms: u64,
}

pub fn write_status(
    layout: &Layout,
    phase: Phase,
    from: Option<&str>,
    to: Option<&str>,
    message: &str,
) -> Result<()> {
    let status = Status {
        phase,
        from: from.map(str::to_string),
        to: to.map(str::to_string),
        message: message.to_string(),
        at_ms: now_ms(),
    };
    // Readable by the service account, which shows it in the console.
    write_atomic(
        &layout.update_status(),
        &serde_json::to_vec(&status)?,
        0o644,
    )
}

pub fn read_status(layout: &Layout) -> Result<Option<Status>> {
    read_small(&layout.update_status())?
        .map(|bytes| serde_json::from_slice(&bytes).context("update-status.json is damaged"))
        .transpose()
}

// ---------------------------------------------------------------------------
// The switch record
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Step {
    /// The service is stopped and `current` may already point at `to`; the
    /// new release has not started, so the database is untouched by it.
    Switching,
    /// The new release was started and may have migrated the database.
    Starting,
    /// The new release failed and declared `from` compatible: going back.
    RollingBack,
}

/// `update-switch.json`: what the updater is doing, so an interruption at
/// any step is finished or undone the same way every time.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Switch {
    pub from: String,
    pub to: String,
    pub step: Step,
    /// The readiness nonce the new release's app must echo.
    pub nonce: String,
    /// The new release's signed manifest lists `from` as able to run on the
    /// database it leaves behind.
    pub rollback_compatible: bool,
}

impl Switch {
    pub fn load(path: &Path) -> Result<Option<Self>> {
        let Some(bytes) = read_small(path)? else {
            return Ok(None);
        };
        let switch: Self = serde_json::from_slice(&bytes)
            .with_context(|| format!("{} is damaged", path.display()))?;
        checked_version(&switch.from)?;
        checked_version(&switch.to)?;
        validate_nonce(&switch.nonce)?;
        Ok(Some(switch))
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        write_atomic(path, &serde_json::to_vec(self)?, 0o644)
    }
}

pub fn new_nonce() -> Result<String> {
    let mut bytes = [0; 32];
    getrandom::getrandom(&mut bytes).context("could not make a readiness nonce")?;
    Ok(hex::encode(bytes))
}

pub fn validate_nonce(value: &str) -> Result<()> {
    if value.len() != 64 || !value.bytes().all(|b| b.is_ascii_hexdigit()) {
        bail!("invalid readiness nonce");
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Readiness and the database copy
// ---------------------------------------------------------------------------

/// `ready.json`, written by the app once it serves requests.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Ready {
    nonce: String,
    version: String,
}

/// Whether the app of `version`, started with `nonce`, reported ready.
pub fn is_ready(layout: &Layout, nonce: &str, version: &str) -> bool {
    match read_small(&layout.ready_file()) {
        Ok(Some(bytes)) => serde_json::from_slice::<Ready>(&bytes)
            .is_ok_and(|ready| ready.nonce == nonce && ready.version == version),
        _ => false,
    }
}

/// Copies the stopped server's database (and a write-ahead log, if one is
/// left) to `backups/pre-update-<from>-to-<to>.db`. `None` when there is no
/// database yet.
pub fn backup_database(layout: &Layout, from: &str, to: &str) -> Result<Option<PathBuf>> {
    let database = layout.database();
    if fs::symlink_metadata(&database).is_err() {
        return Ok(None);
    }
    let backups = layout.backups();
    match fs::symlink_metadata(&backups) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(&backups)
                .with_context(|| format!("could not create {}", backups.display()))?;
        }
        Err(e) => return Err(e.into()),
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {}
        Ok(_) => bail!(
            "{} is a link or not a folder; the updater refuses to follow it",
            backups.display()
        ),
    }
    let copy = backups.join(format!("pre-update-{from}-to-{to}.db"));
    for suffix in ["", "-wal"] {
        let source = PathBuf::from(format!("{}{suffix}", database.display()));
        let target = PathBuf::from(format!("{}{suffix}", copy.display()));
        let mut input = match open_no_follow(&source) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound && !suffix.is_empty() => {
                remove(&target)?;
                continue;
            }
            Err(e) => {
                return Err(e).with_context(|| format!("could not read {}", source.display()))
            }
        };
        let mut output = create_fresh(&target, 0o600)?;
        std::io::copy(&mut input, &mut output)
            .with_context(|| format!("could not copy {}", source.display()))?;
        output.sync_all()?;
    }
    Ok(Some(copy))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::layout::tests::scratch;

    #[test]
    fn links_in_the_data_folder_are_never_followed() {
        let root = scratch("updater-files-links");
        let data = root.join("data");
        fs::create_dir_all(&data).unwrap();
        let secret = root.join("secret");
        fs::write(&secret, b"root only").unwrap();
        let layout = Layout {
            program: root.join("opt"),
            data: data.clone(),
        };

        // A status file planted as a link: replaced, the target untouched.
        std::os::unix::fs::symlink(&secret, layout.update_status()).unwrap();
        write_status(&layout, Phase::Checking, Some("1.0.0"), None, "checking").unwrap();
        assert_eq!(fs::read(&secret).unwrap(), b"root only");
        assert!(!fs::symlink_metadata(layout.update_status())
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(
            read_status(&layout).unwrap().unwrap().phase,
            Phase::Checking
        );

        // A ready file planted as a link is not read.
        std::os::unix::fs::symlink(&secret, layout.ready_file()).unwrap();
        assert!(read_small(&layout.ready_file()).is_err());

        // A backups folder planted as a link is refused.
        fs::write(layout.database(), b"db").unwrap();
        std::os::unix::fs::symlink(&root, layout.backups()).unwrap();
        assert!(backup_database(&layout, "1.0.0", "1.1.0").is_err());
        fs::remove_file(layout.backups()).unwrap();
        let copy = backup_database(&layout, "1.0.0", "1.1.0").unwrap().unwrap();
        assert_eq!(fs::read(copy).unwrap(), b"db");

        // A linked data folder is refused outright.
        let linked = root.join("linked-data");
        std::os::unix::fs::symlink(&data, &linked).unwrap();
        assert!(check_data_dir(&linked).is_err());
        check_data_dir(&data).unwrap();
        fs::remove_dir_all(&root).unwrap();
    }
}
