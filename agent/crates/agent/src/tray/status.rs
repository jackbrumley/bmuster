//! Public tray status: deliberately separate from private agent state.
//! `status.json` says whether the agent is connected; `viewers.json` says
//! who is connected to the screen (SPEC-DESKTOP 8.2).

use super::viewers::{Published, FILE as VIEWERS_FILE};
use anyhow::{bail, Context as _, Result};
use serde::{Deserialize, Serialize};
use std::io::Read as _;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const MAX_AGE_MS: u64 = 20_000;
const MAX_BYTES: u64 = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Connection {
    Connected,
    Reconnecting,
    Offline,
}

impl Connection {
    pub fn from_board(board: &crate::status::Snapshot) -> Self {
        if board.socket_connected {
            Self::Connected
        } else if board.last_check_in.is_some() {
            Self::Reconnecting
        } else {
            Self::Offline
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Connected => "Connected",
            Self::Reconnecting => "Reconnecting",
            Self::Offline => "Offline",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    pub schema_version: u8,
    pub published_at_ms: u64,
    pub process_id: u32,
    pub state: Connection,
    pub url: String,
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

impl Snapshot {
    pub fn new(board: &crate::status::Snapshot, port: u16) -> Self {
        Self {
            schema_version: 1,
            published_at_ms: now_ms(),
            process_id: std::process::id(),
            state: Connection::from_board(board),
            url: format!("https://localhost:{port}/"),
        }
    }

    pub fn validate(&self, now: u64) -> Result<()> {
        if self.schema_version != 1
            || self.process_id == 0
            || self.published_at_ms > now
            || now - self.published_at_ms > MAX_AGE_MS
        {
            bail!("The agent status is missing, expired or unsupported");
        }
        let address = self
            .url
            .strip_prefix("https://")
            .and_then(|s| s.strip_suffix('/'))
            .context("Invalid local management URL")?;
        let port = ["localhost:", "127.0.0.1:", "[::1]:"]
            .into_iter()
            .find_map(|host| address.strip_prefix(host))
            .context("Management URL must use a loopback host")?;
        if port.is_empty()
            || !port.bytes().all(|b| b.is_ascii_digit())
            || port.parse::<u16>().unwrap_or(0) == 0
        {
            bail!("Invalid local management port");
        }
        Ok(())
    }
}

pub fn directory() -> Result<PathBuf> {
    #[cfg(windows)]
    {
        Ok(bmuster_service::windows::known_folder("ProgramData")?.join("BMuster Status"))
    }
    #[cfg(not(windows))]
    {
        Ok(PathBuf::from("/run/bmuster"))
    }
}

/// `status.json`, which tray helpers of every version read.
pub const STATUS_FILE: &str = "status.json";

/// Opens `file` in the status folder, refusing anything root does not own
/// or others can write.
#[cfg(target_os = "linux")]
fn open_public(dir: &Path, file: &str) -> Result<std::fs::File> {
    use std::os::fd::AsRawFd as _;
    use std::os::fd::FromRawFd as _;
    use std::os::unix::fs::{MetadataExt as _, OpenOptionsExt as _};
    let name = std::ffi::CString::new(file)?;
    let directory = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(dir)?;
    let metadata = directory.metadata()?;
    if metadata.uid() != 0 || metadata.mode() & 0o022 != 0 {
        bail!("Tray status directory is not protected by root");
    }
    // The open directory anchors lookup: replacing a pathname cannot redirect this read.
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
        )
    };
    if fd < 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    let file = unsafe { std::fs::File::from_raw_fd(fd) };
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.uid() != 0
        || metadata.mode() & 0o022 != 0
        || metadata.len() > MAX_BYTES
    {
        bail!("Tray status file is not protected by root or exceeds its size limit");
    }
    Ok(file)
}

#[cfg(windows)]
fn open_public(dir: &Path, file: &str) -> Result<std::fs::File> {
    super::windows::open_public(dir, file)
}

#[cfg(not(any(target_os = "linux", windows)))]
fn open_public(_dir: &Path, _file: &str) -> Result<std::fs::File> {
    bail!("Tray status is not implemented on this platform")
}

/// The bytes of `file` in the status folder, at most [`MAX_BYTES`].
fn read_public(dir: &Path, file: &str) -> Result<Vec<u8>> {
    let mut text = Vec::new();
    open_public(dir, file)?
        .take(MAX_BYTES + 1)
        .read_to_end(&mut text)?;
    if text.len() as u64 > MAX_BYTES {
        bail!("Tray status is too large");
    }
    Ok(text)
}

pub fn read_from(dir: &Path) -> Result<Snapshot> {
    let snapshot: Snapshot = serde_json::from_slice(&read_public(dir, STATUS_FILE)?)?;
    snapshot.validate(now_ms())?;
    Ok(snapshot)
}

pub fn read() -> Result<Snapshot> {
    read_from(&directory()?)
}

/// The names in `viewers.json` in `dir`, when it is protected and fresh.
pub fn read_viewers_from(dir: &Path) -> Result<Vec<String>> {
    let published: Published = serde_json::from_slice(&read_public(dir, VIEWERS_FILE)?)?;
    published.validate(now_ms())?;
    Ok(published.names)
}

/// Who is connected to the screen; nobody when the list cannot be read
/// (the agent is not running, or is older than the list).
pub fn read_viewers() -> Vec<String> {
    directory()
        .and_then(|dir| read_viewers_from(&dir))
        .unwrap_or_default()
}

/// How often the publisher looks at the viewers.
const TICK: Duration = Duration::from_secs(1);
/// Each file is written at least this often, so the tray can tell the
/// agent is alive.
const REFRESH: Duration = Duration::from_secs(5);

/// Which files are due: `status.json` every [`REFRESH`], `viewers.json`
/// at once when the names change and every [`REFRESH`] otherwise.
#[derive(Debug, Default)]
pub struct Cadence {
    status_at: Option<Instant>,
    viewers_at: Option<Instant>,
    names: Option<Vec<String>>,
}

/// What [`Cadence::due`] says to write.
#[derive(Debug, PartialEq, Eq)]
pub struct Due {
    pub status: bool,
    pub viewers: bool,
}

impl Cadence {
    pub fn due(&mut self, now: Instant, names: &[String]) -> Due {
        let stale = |at: Option<Instant>| at.is_none_or(|at| now.duration_since(at) >= REFRESH);
        let status = stale(self.status_at);
        let viewers = stale(self.viewers_at) || self.names.as_deref() != Some(names);
        if status {
            self.status_at = Some(now);
        }
        if viewers {
            self.viewers_at = Some(now);
            self.names = Some(names.to_vec());
        }
        Due { status, viewers }
    }
}

/// Writes `file` in `dir` whole: a new file, then a rename over the old.
#[cfg(target_os = "linux")]
fn write_public(dir: &Path, file: &str, bytes: &[u8]) -> Result<()> {
    use std::io::Write as _;
    use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};
    let stem = file.strip_suffix(".json").unwrap_or(file);
    let next = dir.join(format!("{stem}-{}.new", std::process::id()));
    let mut handle = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o644)
        .open(&next)?;
    let written = (|| -> Result<()> {
        handle.write_all(bytes)?;
        handle.set_permissions(std::fs::Permissions::from_mode(0o644))?;
        handle.sync_all()?;
        std::fs::rename(&next, dir.join(file))?;
        Ok(())
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&next);
    }
    written
}

#[cfg(windows)]
fn write_public(dir: &Path, file: &str, bytes: &[u8]) -> Result<()> {
    super::windows::write_public(dir, file, bytes)
}

/// The status folder must be root's and not writable by anyone else.
#[cfg(target_os = "linux")]
fn check_publish_directory(dir: &Path) -> Result<()> {
    use std::os::unix::fs::MetadataExt as _;
    let metadata = std::fs::symlink_metadata(dir).context("Tray status runtime directory is absent; rerun the administrator installer to enable the tray")?;
    if !metadata.is_dir() || metadata.uid() != 0 || metadata.mode() & 0o022 != 0 {
        bail!("Insecure tray runtime directory");
    }
    Ok(())
}

#[cfg(windows)]
fn check_publish_directory(dir: &Path) -> Result<()> {
    super::windows::check_publish_directory(dir)
}

/// Writes `status.json` and `viewers.json` on a thread of its own, as
/// [`Cadence`] says.
#[cfg(any(target_os = "linux", windows))]
pub fn publish(board: std::sync::Arc<crate::status::StatusBoard>, port: u16) -> Result<()> {
    let dir = directory()?;
    check_publish_directory(&dir)?;
    std::thread::Builder::new()
        .name("tray status".into())
        .spawn(move || {
            let mut cadence = Cadence::default();
            loop {
                let names = super::viewers::names();
                let due = cadence.due(Instant::now(), &names);
                if due.status {
                    let snapshot = Snapshot::new(&board.snapshot(), port);
                    let result = serde_json::to_vec(&snapshot)
                        .map_err(anyhow::Error::from)
                        .and_then(|bytes| write_public(&dir, STATUS_FILE, &bytes));
                    if let Err(error) = result {
                        log::warn!("Cannot publish tray status: {error:#}");
                    }
                }
                if due.viewers {
                    let published = Published::new(&names, now_ms());
                    let result = serde_json::to_vec(&published)
                        .map_err(anyhow::Error::from)
                        .and_then(|bytes| write_public(&dir, VIEWERS_FILE, &bytes));
                    if let Err(error) = result {
                        log::warn!("Cannot publish the viewer list: {error:#}");
                    }
                }
                std::thread::sleep(TICK);
            }
        })?;
    Ok(())
}

#[cfg(not(any(target_os = "linux", windows)))]
pub fn publish(_board: std::sync::Arc<crate::status::StatusBoard>, _port: u16) -> Result<()> {
    bail!("Tray not implemented on this platform")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reject_untrusted_status() {
        let at = 100_000;
        let good = Snapshot {
            schema_version: 1,
            published_at_ms: at,
            process_id: 42,
            state: Connection::Connected,
            url: "https://localhost:47501/".into(),
        };
        assert!(good.validate(at).is_ok());
        assert!(good.validate(at + 20_001).is_err());
        assert!(good.validate(at - 1).is_err());
        for url in [
            "http://localhost:47500/",
            "https://example.com:47500/",
            "https://localhost/",
            "https://localhost:0/",
            "https://localhost:47500/@evil",
            "https://localhost:47500/#secret",
            "https://user@localhost:47500/",
            "https://localhost:47500/?command=stop",
        ] {
            let bad = Snapshot {
                url: url.into(),
                ..good.clone()
            };
            assert!(bad.validate(at).is_err(), "accepted {url}");
        }
        for host in ["localhost", "127.0.0.1", "[::1]"] {
            assert!(Snapshot {
                url: format!("https://{host}:47500/"),
                ..good.clone()
            }
            .validate(at)
            .is_ok());
        }
    }

    #[test]
    fn publish_connection_transitions() {
        let board = crate::status::StatusBoard::new(60);
        assert_eq!(
            Connection::from_board(&board.snapshot()),
            Connection::Offline
        );
        board.checked_in("private machine", 60);
        assert_eq!(
            Connection::from_board(&board.snapshot()),
            Connection::Reconnecting
        );
        board.socket(true);
        assert_eq!(
            Connection::from_board(&board.snapshot()),
            Connection::Connected
        );
        let snapshot = Snapshot::new(&board.snapshot(), 47591);
        let text = serde_json::to_string(&snapshot).unwrap();
        assert!(!text.contains("private machine"));
        assert!(snapshot.validate(now_ms()).is_ok());
        assert_eq!(snapshot.url, "https://localhost:47591/");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn status_reader_rejects_symlinks_and_writable_paths() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("status.json");
        std::fs::write(&file, b"{}").unwrap();
        assert!(
            read_from(dir.path()).is_err(),
            "unprivileged directory cannot claim to be root status"
        );
        let link = dir.path().join("link");
        symlink(&file, &link).unwrap();
        assert!(read_from(&link).is_err());
        std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o777)).unwrap();
        assert!(read_from(dir.path()).is_err());
    }

    /// The viewer list is read with the status file's protections.
    #[cfg(target_os = "linux")]
    #[test]
    fn tray_viewers_reader_rejects_an_unprotected_folder() {
        let dir = tempfile::tempdir().unwrap();
        write_public(
            dir.path(),
            VIEWERS_FILE,
            &serde_json::to_vec(&Published::new(&["Kim".into()], now_ms())).unwrap(),
        )
        .unwrap();
        assert!(dir.path().join(VIEWERS_FILE).is_file(), "written whole");
        assert!(
            read_viewers_from(dir.path()).is_err(),
            "an unprivileged folder cannot claim to be the agent's"
        );
    }

    #[test]
    fn tray_viewers_are_published_at_once_when_they_change() {
        let start = Instant::now();
        let mut cadence = Cadence::default();
        let kim = vec!["Kim".to_string()];
        let due = |status, viewers| Due { status, viewers };
        assert_eq!(cadence.due(start, &[]), due(true, true), "both at start");
        let second = start + TICK;
        assert_eq!(cadence.due(second, &[]), due(false, false));
        assert_eq!(cadence.due(second, &kim), due(false, true), "Kim joined");
        assert_eq!(cadence.due(second + TICK, &kim), due(false, false));
        assert_eq!(
            cadence.due(start + REFRESH, &kim),
            due(true, false),
            "status every five seconds"
        );
        assert_eq!(
            cadence.due(second + REFRESH, &kim),
            due(false, true),
            "the list too, so it never goes stale"
        );
        assert_eq!(
            cadence.due(second + REFRESH, &[]),
            due(false, true),
            "Kim left"
        );
    }
}
