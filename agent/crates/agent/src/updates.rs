//! Signed updates (SPEC-AGENT-UPDATES): which release keys this build trusts,
//! how a build is checked, where versions live on disk, the last update event,
//! and the worker's part: download and check an offered build and hand it to
//! the launcher (`launcher.rs`), which switches and rolls back.
//!
//! On disk (only root or SYSTEM can write either folder). The versions are
//! program files: on Linux they live in `/opt/bmuster/versions`, because
//! systemd may not run programs from `/var/lib` (SPEC-SESSION-UNITS,
//! Version 3); on Windows in `C:\ProgramData\BMuster\versions`.
//!
//! ```text
//! versions/<version>/  bmuster-agent + release.json   one per version (Unix)
//! versions/current     link to the running worker's folder (Unix; a folder on Windows)
//! versions/previous    link to the version before, kept for a rollback
//! versions/incoming/   a downloaded build, checked, waiting for the switch
//! <state>/switch.json   a switch on trial (from, to): the commit point
//! <state>/checked-in    written by a worker after its first check-in (<state>:
//!                       the data folder; on Windows its versions folder)
//! <data>/update-state.json   the last update event, reported in every check-in
//! ```

use crate::client::{Channel, Session};
use crate::identity::write_private;
use anyhow::{bail, Context as _, Result};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use bmuster_protocol::{
    decode_public_key, release_message, release_path, sha256_hex, AgentVersion, UpdateEvent,
    UpdateOffer, UpdateReport,
};
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// This build's version: `BMUSTER_VERSION` at build time, else Cargo's.
pub const VERSION: &str = env!("BMUSTER_VERSION");
/// The target triple this build was made for.
pub const TARGET: &str = env!("BMUSTER_TARGET");

/// No agent build comes near this; a bigger offer is refused unread.
const MAX_BUILD_BYTES: u64 = 200 * 1024 * 1024;
/// A download of a few megabytes over a slow link.
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(600);

pub const BINARY_NAME: &str = if cfg!(windows) {
    "bmuster-agent.exe"
} else {
    "bmuster-agent"
};
pub const RELEASE_FILE: &str = "release.json";
const SWITCH_FILE: &str = "switch.json";
const CHECKED_IN_FILE: &str = "checked-in";
const STATE_FILE: &str = "update-state.json";

// ---------------------------------------------------------------------------
// Trusted keys and checks
// ---------------------------------------------------------------------------

/// The release keys this build trusts: the project's, plus the one given at
/// build time in `BMUSTER_EXTRA_RELEASE_KEY` (development builds and
/// self-builders), if any. build.rs has checked both.
pub fn trusted_keys() -> Vec<VerifyingKey> {
    [
        env!("BMUSTER_RELEASE_KEY"),
        env!("BMUSTER_EXTRA_RELEASE_KEY"),
    ]
    .into_iter()
    .filter(|text| !text.is_empty())
    .filter_map(|text| decode_public_key(text).ok())
    .collect()
}

/// One agent build as the server offers it and as it sits in a version folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Release {
    pub version: String,
    pub target: String,
    pub size: u64,
    pub sha256: String,
    /// Empty for the build the launcher was installed as (it trusts itself).
    pub signature: String,
}

impl Release {
    pub fn of_offer(offer: &UpdateOffer) -> Option<Self> {
        match offer {
            UpdateOffer::None => None,
            UpdateOffer::Offer {
                version,
                size,
                sha256,
                signature,
            } => Some(Self {
                version: version.clone(),
                target: TARGET.to_string(),
                size: *size,
                sha256: sha256.clone(),
                signature: signature.clone(),
            }),
        }
    }
}

/// Checks everything that can be checked before downloading: the target, a
/// newer version, a sane size, and a signature by a trusted key over the
/// version, target, size and SHA-256. The reason is shown to admins.
pub fn check_offer(
    release: &Release,
    current: &str,
    keys: &[VerifyingKey],
) -> std::result::Result<(), String> {
    if release.target != TARGET {
        return Err(format!(
            "the build is for {}, but this agent is {TARGET}",
            release.target
        ));
    }
    let offered = AgentVersion::parse(&release.version).map_err(|e| e.to_string())?;
    let running = AgentVersion::parse(current).map_err(|e| e.to_string())?;
    if offered <= running {
        return Err(format!(
            "version {offered} is not newer than the running {running}"
        ));
    }
    if release.size == 0 || release.size > MAX_BUILD_BYTES {
        return Err(format!("the build size {} is not believable", release.size));
    }
    if release.sha256.len() != 64 || !release.sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("the SHA-256 is not 64 hex digits".into());
    }
    let signature: [u8; 64] = BASE64
        .decode(release.signature.trim())
        .ok()
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or("the signature is missing or not a 64-byte Ed25519 signature")?;
    let signature = Signature::from_bytes(&signature);
    let message = release_message(
        &release.version,
        &release.target,
        release.size,
        &release.sha256.to_ascii_lowercase(),
    );
    if keys
        .iter()
        .any(|key| key.verify_strict(message.as_bytes(), &signature).is_ok())
    {
        Ok(())
    } else {
        Err("the signature is not from a release key this agent trusts".into())
    }
}

/// [`check_offer`] and then the bytes themselves: size and SHA-256.
pub fn check_build(
    release: &Release,
    bytes: &[u8],
    current: &str,
    keys: &[VerifyingKey],
) -> std::result::Result<(), String> {
    check_offer(release, current, keys)?;
    if bytes.len() as u64 != release.size {
        return Err(format!(
            "the download is {} bytes, but the signed size is {}",
            bytes.len(),
            release.size
        ));
    }
    if sha256_hex(bytes) != release.sha256.to_ascii_lowercase() {
        return Err("the download's SHA-256 does not match the signed one".into());
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Version folders
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Slot {
    Current,
    Previous,
    Incoming,
}

impl Slot {
    fn name(self) -> &'static str {
        match self {
            Slot::Current => "current",
            Slot::Previous => "previous",
            Slot::Incoming => "incoming",
        }
    }
}

/// The version folders (under [`crate::paths::versions_dir`]) and the
/// update state kept beside the data (switch record, check-in marker).
#[derive(Debug, Clone)]
pub struct Layout {
    root: PathBuf,
    data: PathBuf,
}

/// A switch waiting for its health check: the commit point of an update.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Switch {
    pub from: String,
    pub to: String,
}

impl Layout {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            root: crate::paths::versions_dir(data_dir),
            data: state_dir(data_dir),
        }
    }

    #[cfg(test)]
    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn dir(&self, slot: Slot) -> PathBuf {
        self.root.join(slot.name())
    }

    pub fn binary(&self, slot: Slot) -> PathBuf {
        self.dir(slot).join(BINARY_NAME)
    }

    pub fn checked_in_marker(&self) -> PathBuf {
        self.data.join(CHECKED_IN_FILE)
    }

    fn switch_path(&self) -> PathBuf {
        self.data.join(SWITCH_FILE)
    }

    pub fn release(&self, slot: Slot) -> Result<Release> {
        let path = self.dir(slot).join(RELEASE_FILE);
        let text = fs::read_to_string(&path)
            .with_context(|| format!("could not read {}", path.display()))?;
        serde_json::from_str(&text).with_context(|| format!("{} is damaged", path.display()))
    }

    /// Makes the versions folder, readable by everyone: user helpers run
    /// the current binary as the signed-in person (the agent's own umask
    /// is 0077).
    pub fn create_root(&self) -> Result<()> {
        fs::create_dir_all(&self.root)
            .with_context(|| format!("could not create {}", self.root.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            fs::set_permissions(&self.root, fs::Permissions::from_mode(0o755))?;
        }
        Ok(())
    }

    /// Writes a downloaded build into `incoming`.
    pub fn store_incoming(&self, release: &Release, bytes: &[u8]) -> Result<()> {
        self.create_root()?;
        write_version(&self.dir(Slot::Incoming), release, bytes)
    }

    /// Removes a downloaded build that was refused.
    pub fn remove_incoming(&self) -> Result<()> {
        let dir = self.dir(Slot::Incoming);
        if dir.exists() {
            fs::remove_dir_all(&dir)
                .with_context(|| format!("could not remove {}", dir.display()))?;
        }
        Ok(())
    }

    pub fn switch(&self) -> Result<Option<Switch>> {
        let path = self.switch_path();
        if !path.exists() {
            return Ok(None);
        }
        let text = fs::read_to_string(&path)
            .with_context(|| format!("could not read {}", path.display()))?;
        Ok(Some(serde_json::from_str(&text).with_context(|| {
            format!("{} is damaged", path.display())
        })?))
    }

    pub fn begin_switch(&self, switch: &Switch) -> Result<()> {
        write_private(&self.switch_path(), &serde_json::to_vec(switch)?)
    }

    pub fn end_switch(&self) -> Result<()> {
        let path = self.switch_path();
        if path.exists() {
            fs::remove_file(&path)
                .with_context(|| format!("could not remove {}", path.display()))?;
        }
        Ok(())
    }
}

/// Where the switch record, the check-in marker and the rescue copy's
/// record live. Unix: the data folder, because on Linux the versions are
/// program files under /opt. Windows: the versions folder in the data
/// folder, as before, because the launcher there is the Program Files copy,
/// which may be older than the worker and looks for them there.
pub fn state_dir(data_dir: &Path) -> PathBuf {
    if cfg!(windows) {
        crate::paths::versions_dir(data_dir)
    } else {
        data_dir.to_path_buf()
    }
}

/// One version's binary (0755: user helpers run it) and release.json, in a
/// fresh `dir`. The bytes are written there, never renamed in from another
/// folder, so on Linux they take the folder's SELinux label.
fn write_version(dir: &Path, release: &Release, bytes: &[u8]) -> Result<()> {
    if dir.exists() {
        fs::remove_dir_all(dir).with_context(|| format!("could not clear {}", dir.display()))?;
    }
    fs::create_dir_all(dir).with_context(|| format!("could not create {}", dir.display()))?;
    let binary = dir.join(BINARY_NAME);
    fs::write(&binary, bytes).with_context(|| format!("could not write {}", binary.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o755))?;
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o755))?;
    }
    let mut json = serde_json::to_vec_pretty(release)?;
    json.push(b'\n');
    write_private(&dir.join(RELEASE_FILE), &json)
}

/// A version as a folder name: only what [`AgentVersion`] accepts (digits,
/// letters, dots and dashes), so it can never name another path.
#[cfg(unix)]
fn version_folder(version: &str) -> Result<String> {
    Ok(AgentVersion::parse(version)?.as_str().to_string())
}

/// Unix: each version in its own folder, `versions/<version>/`, and
/// `current` and `previous` are links to them, switched by renaming a new
/// link over the old one (atomic: `current` always names a version).
#[cfg(unix)]
impl Layout {
    /// The version a link names, if it is there.
    fn linked(&self, slot: Slot) -> Option<String> {
        let target = fs::read_link(self.dir(slot)).ok()?;
        Some(target.to_str()?.to_string())
    }

    fn link(&self, slot: Slot, version: &str) -> Result<()> {
        let link = self.dir(slot);
        let temp = self.root.join(format!(".{}.new", slot.name()));
        if fs::symlink_metadata(&temp).is_ok() {
            fs::remove_file(&temp)
                .with_context(|| format!("could not remove {}", temp.display()))?;
        }
        std::os::unix::fs::symlink(version, &temp)
            .with_context(|| format!("could not make {}", temp.display()))?;
        fs::rename(&temp, &link).with_context(|| format!("could not replace {}", link.display()))
    }

    fn unlink(&self, slot: Slot) -> Result<()> {
        let link = self.dir(slot);
        if fs::symlink_metadata(&link).is_ok() {
            fs::remove_file(&link)
                .with_context(|| format!("could not remove {}", link.display()))?;
        }
        Ok(())
    }

    /// Removes version folders no link names (and a seed left by a crash).
    fn prune(&self) -> Result<()> {
        let keep = [self.linked(Slot::Current), self.linked(Slot::Previous)];
        for entry in fs::read_dir(&self.root)
            .with_context(|| format!("could not read {}", self.root.display()))?
        {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let is_dir = entry.file_type()?.is_dir();
            let named = keep
                .iter()
                .any(|kept| kept.as_deref() == Some(name.as_str()));
            if is_dir && !named && AgentVersion::parse(&name).is_ok() {
                fs::remove_dir_all(entry.path())
                    .with_context(|| format!("could not remove {}", entry.path().display()))?;
            }
        }
        Ok(())
    }

    /// Puts `bytes` in `versions/<version>` and points `current` at it.
    pub fn seed_current(&self, release: &Release, bytes: &[u8]) -> Result<()> {
        self.create_root()?;
        let version = version_folder(&release.version)?;
        write_version(&self.root.join(&version), release, bytes)?;
        self.link(Slot::Current, &version)?;
        self.prune()
    }

    /// The switch: the build in `incoming` (or already moved to its own
    /// folder by an interrupted switch) becomes `current`, and what was
    /// `current` becomes `previous`. The folder is renamed within the
    /// versions folder only, so it keeps the label it was written with.
    pub fn promote(&self, version: &str) -> Result<()> {
        let version = version_folder(version)?;
        let target = self.root.join(&version);
        let incoming = self.release(Slot::Incoming).ok();
        if incoming.is_some_and(|release| release.version == version) {
            if self.linked(Slot::Current).as_deref() == Some(version.as_str()) {
                bail!("version {version} is already current");
            }
            if target.exists() {
                fs::remove_dir_all(&target)
                    .with_context(|| format!("could not clear {}", target.display()))?;
            }
            fs::rename(self.dir(Slot::Incoming), &target)
                .with_context(|| format!("could not move the build to {}", target.display()))?;
        }
        if !target.join(BINARY_NAME).exists() {
            bail!("{} is missing", target.join(BINARY_NAME).display());
        }
        if let Some(current) = self
            .linked(Slot::Current)
            .filter(|current| *current != version)
        {
            self.link(Slot::Previous, &current)?;
        }
        self.link(Slot::Current, &version)?;
        self.prune()
    }

    /// The rollback: `previous` becomes `current` again, and the failed
    /// version's folder goes.
    pub fn restore_previous(&self) -> Result<()> {
        let previous = self
            .linked(Slot::Previous)
            .with_context(|| format!("{} is missing", self.dir(Slot::Previous).display()))?;
        self.link(Slot::Current, &previous)?;
        self.unlink(Slot::Previous)?;
        self.prune()
    }
}

/// Windows: `current`, `previous` and `incoming` are folders, switched by
/// renaming (the service runs the Program Files copy, not `current`).
#[cfg(not(unix))]
impl Layout {
    fn rename(&self, from: Slot, to: Slot) -> Result<()> {
        let (source, target) = (self.dir(from), self.dir(to));
        if target.exists() {
            fs::remove_dir_all(&target)
                .with_context(|| format!("could not remove {}", target.display()))?;
        }
        fs::rename(&source, &target).with_context(|| {
            format!(
                "could not move {} to {}",
                source.display(),
                target.display()
            )
        })
    }

    pub fn seed_current(&self, release: &Release, bytes: &[u8]) -> Result<()> {
        self.create_root()?;
        write_version(&self.dir(Slot::Current), release, bytes)
    }

    /// The switch: `current` becomes `previous` and `incoming` `current`.
    /// After a crash between the two, only the second is left to do.
    pub fn promote(&self, version: &str) -> Result<()> {
        let incoming = self.release(Slot::Incoming)?;
        if incoming.version != version {
            bail!("the waiting build is {}, not {version}", incoming.version);
        }
        if self.binary(Slot::Current).exists() {
            self.rename(Slot::Current, Slot::Previous)?;
        }
        self.rename(Slot::Incoming, Slot::Current)
    }

    pub fn restore_previous(&self) -> Result<()> {
        if !self.binary(Slot::Previous).exists() {
            bail!("{} is missing", self.dir(Slot::Previous).display());
        }
        self.rename(Slot::Previous, Slot::Current)
    }
}

/// Puts `bytes` in `current` as `version`, unsigned: the build that was
/// installed (or the rescue copy), which the machine trusts as it is.
pub fn seed_current(layout: &Layout, bytes: &[u8], version: &str) -> Result<()> {
    let release = Release {
        version: version.to_string(),
        target: TARGET.to_string(),
        size: bytes.len() as u64,
        sha256: sha256_hex(bytes),
        signature: String::new(),
    };
    layout.seed_current(&release, bytes)
}

/// Removes every version and the update state that goes with them
/// (uninstall without --purge keeps only the identity).
pub fn remove_versions(data_dir: &Path) -> Result<()> {
    let layout = Layout::new(data_dir);
    // Also the folder Linux installs used before SPEC-SESSION-UNITS
    // Version 3 (the same folder elsewhere).
    for folder in [layout.root.clone(), data_dir.join("versions")] {
        if folder.exists() {
            fs::remove_dir_all(&folder)
                .with_context(|| format!("could not remove {}", folder.display()))?;
        }
    }
    for file in [
        layout.switch_path(),
        layout.checked_in_marker(),
        crate::rescue::record_path(data_dir),
    ] {
        if file.exists() {
            fs::remove_file(&file)
                .with_context(|| format!("could not remove {}", file.display()))?;
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// The last update event
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct State {
    last: UpdateEvent,
}

pub fn now_ms() -> i64 {
    let since = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO);
    i64::try_from(since.as_millis()).unwrap_or(i64::MAX)
}

/// The last update event; `None` when there was none or the file is damaged.
pub fn last_event(data_dir: &Path) -> UpdateEvent {
    let path = data_dir.join(STATE_FILE);
    let Ok(text) = fs::read_to_string(&path) else {
        return UpdateEvent::None;
    };
    match serde_json::from_str::<State>(&text) {
        Ok(state) => state.last,
        Err(e) => {
            log::warn!("{} is damaged ({e}); ignoring it.", path.display());
            UpdateEvent::None
        }
    }
}

pub fn record_event(data_dir: &Path, event: UpdateEvent) -> Result<()> {
    let json = serde_json::to_vec_pretty(&State { last: event })?;
    write_private(&data_dir.join(STATE_FILE), &json)
}

/// What a check-in says about updates.
pub fn report(data_dir: &Path, launched: bool) -> UpdateReport {
    if launched {
        UpdateReport::Launcher {
            last: last_event(data_dir),
            launcher_version: crate::rescue::recorded_version(data_dir),
        }
    } else {
        UpdateReport::NoLauncher
    }
}

/// The local page's Updates line.
pub fn describe_state(data_dir: &Path, launched: bool) -> String {
    if launched {
        format!("automatic, signed; {}", describe(&last_event(data_dir)))
    } else {
        "off: this agent was not started by its launcher. Reinstall it once \
         (console: machine, Manage, Reinstall agent) to get automatic updates."
            .into()
    }
}

/// One line about the last event, for `status` and the local page.
pub fn describe(event: &UpdateEvent) -> String {
    match event {
        UpdateEvent::None => "no update yet".into(),
        UpdateEvent::Updated { from, to, .. } => format!("updated from {from} to {to}"),
        UpdateEvent::RolledBack {
            version, reason, ..
        } => format!("rolled back from {version}: {reason}"),
        UpdateEvent::Refused {
            version, reason, ..
        } => format!("refused {version}: {reason}"),
    }
}

// ---------------------------------------------------------------------------
// The worker's part
// ---------------------------------------------------------------------------

/// What the check-in loop knows about updates.
pub struct WorkerUpdates {
    data_dir: PathBuf,
    /// Started by the launcher (`run --launched`); otherwise updates are off.
    launched: bool,
    keys: Vec<VerifyingKey>,
    marked: AtomicBool,
    /// When this worker started; after a day of check-ins it becomes the
    /// rescue copy (`rescue.rs`), once per run.
    started: Instant,
    refresh_asked: AtomicBool,
    /// Builds refused in this run (version, SHA-256): not downloaded again.
    refused: Mutex<Vec<(String, String)>>,
}

/// What became of an offer.
#[derive(Debug, PartialEq, Eq)]
pub enum Considered {
    /// Nothing to do (no offer, refused before, or not under the launcher).
    Nothing,
    /// The build is checked and in `versions/incoming`: exit for the launcher.
    Ready,
}

impl WorkerUpdates {
    pub fn new(data_dir: &Path, launched: bool) -> Self {
        Self::with_keys(data_dir, launched, trusted_keys())
    }

    pub fn with_keys(data_dir: &Path, launched: bool, keys: Vec<VerifyingKey>) -> Self {
        Self {
            data_dir: data_dir.to_path_buf(),
            launched,
            keys,
            marked: AtomicBool::new(false),
            started: Instant::now(),
            refresh_asked: AtomicBool::new(false),
            refused: Mutex::new(Vec::new()),
        }
    }

    pub fn report(&self) -> UpdateReport {
        report(&self.data_dir, self.launched)
    }

    /// After a successful check-in: tells the launcher this version works,
    /// and after a day of them makes it the rescue copy.
    pub fn checked_in(&self) {
        if !self.launched {
            return;
        }
        if !self.refresh_asked.load(Ordering::SeqCst)
            && crate::rescue::refresh_due(
                crate::rescue::recorded_version(&self.data_dir).as_deref(),
                VERSION,
                self.started.elapsed(),
            )
        {
            self.refresh_asked.store(true, Ordering::SeqCst);
            log::info!("Version {VERSION} has been healthy for a day; making it the rescue copy.");
            if let Err(e) = crate::platform::refresh_rescue_copy() {
                log::error!("Could not refresh the rescue copy: {e:#}");
            }
        }
        if self.marked.load(Ordering::SeqCst) {
            return;
        }
        let marker = Layout::new(&self.data_dir).checked_in_marker();
        match write_private(&marker, VERSION.as_bytes()) {
            Ok(()) => self.marked.store(true, Ordering::SeqCst),
            Err(e) => log::error!("Could not tell the launcher this version works: {e:#}"),
        }
        #[cfg(target_os = "linux")]
        crate::move_to_opt::checked_in(&self.data_dir);
    }

    /// Downloads and checks an offered build. A build that fails a check is
    /// recorded as refused (and reported in the next check-in); a download
    /// that fails is tried again at the next check-in.
    pub fn consider(&self, session: &Session, offer: &UpdateOffer) -> Considered {
        let Some(release) = Release::of_offer(offer) else {
            return Considered::Nothing;
        };
        if !self.launched {
            log::debug!(
                "Version {} is on offer, but this agent runs without the launcher.",
                release.version
            );
            return Considered::Nothing;
        }
        #[cfg(target_os = "linux")]
        if crate::move_to_opt::pending(&self.data_dir) {
            log::debug!(
                "Version {} is on offer; it is taken once the agent runs from /opt/bmuster.",
                release.version
            );
            return Considered::Nothing;
        }
        let key = (release.version.clone(), release.sha256.clone());
        if self.refused().contains(&key) {
            return Considered::Nothing;
        }
        log::info!("Version {} is on offer; checking it.", release.version);
        if let Err(reason) = check_offer(&release, VERSION, &self.keys) {
            self.refuse(key, &release.version, &reason);
            return Considered::Nothing;
        }
        let bytes = match download(session, &release) {
            Ok(bytes) => bytes,
            Err(e) => {
                log::warn!(
                    "Could not download version {}: {e:#}; trying again later.",
                    release.version
                );
                return Considered::Nothing;
            }
        };
        if let Err(reason) = check_build(&release, &bytes, VERSION, &self.keys) {
            self.refuse(key, &release.version, &reason);
            return Considered::Nothing;
        }
        match Layout::new(&self.data_dir).store_incoming(&release, &bytes) {
            Ok(()) => {
                log::info!(
                    "Version {} is downloaded and its signature checks out; handing over to the launcher.",
                    release.version
                );
                Considered::Ready
            }
            Err(e) => {
                log::error!("Could not store version {}: {e:#}", release.version);
                Considered::Nothing
            }
        }
    }

    fn refused(&self) -> MutexGuard<'_, Vec<(String, String)>> {
        // panic = "abort": a poisoned lock cannot hold half-made changes.
        self.refused
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn refuse(&self, key: (String, String), version: &str, reason: &str) {
        log::warn!("Refused version {version}: {reason}.");
        self.refused().push(key);
        let event = UpdateEvent::Refused {
            version: version.to_string(),
            reason: reason.to_string(),
            at_ms: now_ms(),
        };
        if let Err(e) = record_event(&self.data_dir, event) {
            log::error!("Could not record the refusal: {e:#}");
        }
    }
}

/// Fetches a build over the session's connection: the same certificate
/// check (trust store or pinned key, following a planned change) as every
/// other request to this server.
fn download(session: &Session, release: &Release) -> Result<Vec<u8>> {
    let path = release_path(&release.version, &release.target);
    let bytes = session
        .transport
        .exchange(|channel: &Channel| channel.get_bytes(&path, release.size, DOWNLOAD_TIMEOUT))?;
    if bytes.is_empty() {
        bail!("the server sent an empty build");
    }
    Ok(bytes)
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use ed25519_dalek::{Signer as _, SigningKey};

    pub fn test_key() -> SigningKey {
        SigningKey::from_bytes(&[9; 32])
    }

    /// A release of `bytes` as `version` for this target, signed by `key`.
    pub fn signed(version: &str, bytes: &[u8], key: &SigningKey) -> Release {
        let sha256 = sha256_hex(bytes);
        let message = release_message(version, TARGET, bytes.len() as u64, &sha256);
        Release {
            version: version.into(),
            target: TARGET.into(),
            size: bytes.len() as u64,
            sha256,
            signature: BASE64.encode(key.sign(message.as_bytes()).to_bytes()),
        }
    }

    #[test]
    fn a_signed_newer_build_passes() {
        let key = test_key();
        let release = signed("99.0.0", b"agent", &key);
        assert_eq!(
            check_build(&release, b"agent", "1.0.0", &[key.verifying_key()]),
            Ok(())
        );
    }

    #[test]
    fn a_build_signed_by_another_key_is_refused() {
        let release = signed("99.0.0", b"agent", &SigningKey::from_bytes(&[8; 32]));
        let reason =
            check_build(&release, b"agent", "1.0.0", &[test_key().verifying_key()]).unwrap_err();
        assert!(reason.contains("not from a release key"), "{reason}");
    }

    #[test]
    fn a_changed_build_or_changed_details_are_refused() {
        let key = test_key();
        let keys = [key.verifying_key()];
        let release = signed("99.0.0", b"agent", &key);
        assert!(check_build(&release, b"agenT", "1.0.0", &keys)
            .unwrap_err()
            .contains("SHA-256"));
        assert!(check_build(&release, b"agent!", "1.0.0", &keys)
            .unwrap_err()
            .contains("bytes"));
        // The signature covers the version: relabelling a build breaks it.
        let relabelled = Release {
            version: "99.0.1".into(),
            ..release.clone()
        };
        assert!(check_build(&relabelled, b"agent", "1.0.0", &keys)
            .unwrap_err()
            .contains("signature"));
        let foreign = Release {
            target: "riscv64gc-unknown-linux-gnu".into(),
            ..release.clone()
        };
        assert!(check_offer(&foreign, "1.0.0", &keys)
            .unwrap_err()
            .contains("is for riscv64gc"));
        let unsigned = Release {
            signature: String::new(),
            ..release
        };
        assert!(check_offer(&unsigned, "1.0.0", &keys)
            .unwrap_err()
            .contains("missing"));
    }

    #[test]
    fn an_older_or_equal_build_is_refused() {
        let key = test_key();
        let keys = [key.verifying_key()];
        assert!(check_offer(&signed("1.0.0", b"a", &key), "1.0.0", &keys).is_err());
        assert!(check_offer(&signed("1.0.0-dev.5", b"a", &key), "1.0.0", &keys).is_err());
        assert!(check_offer(&signed("1.0.0", b"a", &key), "1.0.0-dev.5", &keys).is_ok());
    }

    #[test]
    fn this_build_trusts_its_release_key_and_no_unknown_one() {
        let keys = trusted_keys();
        assert!(!keys.is_empty());
        assert!(!keys.contains(&test_key().verifying_key()));
        AgentVersion::parse(VERSION).unwrap();
    }

    #[test]
    fn events_survive_a_restart_and_a_damaged_file_reads_as_none() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(last_event(dir.path()), UpdateEvent::None);
        let event = UpdateEvent::RolledBack {
            version: "2.0.0".into(),
            reason: "no check-in".into(),
            at_ms: 7,
        };
        record_event(dir.path(), event.clone()).unwrap();
        assert_eq!(last_event(dir.path()), event);
        fs::write(dir.path().join(STATE_FILE), "{").unwrap();
        assert_eq!(last_event(dir.path()), UpdateEvent::None);
    }

    /// SPEC-SESSION-UNITS O1: the installed agent's versions are program
    /// files under /opt/bmuster; each is written into its own folder there
    /// (never renamed in from elsewhere), and `current` and `previous` are
    /// links to version folders.
    #[cfg(unix)]
    #[test]
    fn versions_are_written_under_opt() {
        use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};
        #[cfg(target_os = "linux")]
        {
            let installed = Layout::new(Path::new("/var/lib/bmuster"));
            assert_eq!(installed.root(), Path::new("/opt/bmuster/versions"));
            assert_eq!(
                installed.binary(Slot::Current),
                Path::new(crate::paths::CURRENT_PROGRAM)
            );
            assert_eq!(
                installed.checked_in_marker(),
                Path::new("/var/lib/bmuster/checked-in")
            );
        }
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path());
        let key = test_key();
        seed_current(&layout, b"agent 1", "1.0.0").unwrap();
        let incoming = signed("2.0.0", b"agent 2", &key);
        layout.store_incoming(&incoming, b"agent 2").unwrap();
        assert!(layout.dir(Slot::Incoming).starts_with(layout.root()));
        let written = fs::metadata(layout.binary(Slot::Incoming)).unwrap();
        layout.promote("2.0.0").unwrap();

        let link = |slot| fs::read_link(layout.dir(slot)).unwrap();
        assert_eq!(link(Slot::Current), Path::new("2.0.0"));
        assert_eq!(link(Slot::Previous), Path::new("1.0.0"));
        assert!(!layout.dir(Slot::Incoming).exists());
        let binary = layout.root().join("2.0.0").join(BINARY_NAME);
        let metadata = fs::symlink_metadata(&binary).unwrap();
        assert!(metadata.is_file());
        // The same file that was written in the versions folder.
        assert_eq!(metadata.ino(), written.ino());
        assert_eq!(metadata.permissions().mode() & 0o777, 0o755);
        assert_eq!(fs::read(layout.binary(Slot::Current)).unwrap(), b"agent 2");
        assert_eq!(layout.release(Slot::Current).unwrap(), incoming);
        assert_eq!(layout.release(Slot::Previous).unwrap().version, "1.0.0");

        // The next switch keeps two versions; the oldest folder goes.
        let third = signed("3.0.0", b"agent 3", &key);
        layout.store_incoming(&third, b"agent 3").unwrap();
        layout.promote("3.0.0").unwrap();
        assert_eq!(link(Slot::Previous), Path::new("2.0.0"));
        assert!(!layout.root().join("1.0.0").exists());

        // A rollback points `current` back and removes the failed version.
        layout.restore_previous().unwrap();
        assert_eq!(link(Slot::Current), Path::new("2.0.0"));
        assert!(fs::symlink_metadata(layout.dir(Slot::Previous)).is_err());
        assert!(!layout.root().join("3.0.0").exists());
        assert!(layout.restore_previous().is_err());

        // A release can never name a folder outside the versions.
        let mut sneaky = incoming.clone();
        sneaky.version = "../../etc".into();
        assert!(layout.seed_current(&sneaky, b"x").is_err());
    }

    #[test]
    fn a_worker_without_the_launcher_reports_so_and_ignores_offers() {
        let dir = tempfile::tempdir().unwrap();
        let updates = WorkerUpdates::with_keys(dir.path(), false, vec![]);
        assert_eq!(updates.report(), UpdateReport::NoLauncher);
        updates.checked_in();
        assert!(!Layout::new(dir.path()).checked_in_marker().exists());
    }

    #[test]
    fn a_launched_worker_marks_its_first_check_in() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(Layout::new(dir.path()).root()).unwrap();
        let updates = WorkerUpdates::with_keys(dir.path(), true, vec![]);
        assert_eq!(
            updates.report(),
            UpdateReport::Launcher {
                last: UpdateEvent::None,
                launcher_version: None,
            }
        );
        updates.checked_in();
        assert_eq!(
            fs::read_to_string(Layout::new(dir.path()).checked_in_marker()).unwrap(),
            VERSION
        );
    }
}
