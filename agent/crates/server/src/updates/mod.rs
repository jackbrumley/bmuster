//! Verified, recoverable application updates under an unprivileged launcher.
mod archive;
mod download;
mod manifest;
mod state;

use crate::{
    layout::{self, Layout},
    node,
};
use anyhow::{bail, Context as _, Result};
use serde::Deserialize;
use state::State;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::time::{Duration, Instant};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    version: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Ready {
    nonce: String,
    version: String,
    process_id: u32,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Prepared {
    nonce: String,
    error: Option<String>,
}

pub struct Supervisor {
    layout: Layout,
    root: PathBuf,
    state: State,
    child: Child,
    nonce: String,
    ready: bool,
    deadline: Instant,
    _lock: File,
    log: Option<File>,
}

fn cleanup_staging(root: &Path) -> Result<()> {
    for name in ["prepare.json", "prepared.json", "request.json"] {
        match std::fs::remove_file(root.join(name)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    let incoming = root.join("incoming");
    match std::fs::symlink_metadata(&incoming) {
        Ok(metadata) if metadata.is_dir() && !metadata.file_type().is_symlink() => {
            std::fs::remove_dir_all(incoming)?;
        }
        Ok(_) => bail!("The server update staging path is not a regular directory"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

/// An administrator-installed bundle becomes the new source of truth. The
/// database and saved compatible snapshots stay untouched.
pub fn reset_for_installer(layout: &Layout) -> Result<()> {
    let root = layout.data.join("server-updates");
    std::fs::create_dir_all(&root)?;
    cleanup_staging(&root)?;
    State::default().save(&root.join("state.json"))
}

fn read_small(path: &Path) -> Result<Vec<u8>> {
    use std::io::Read as _;
    let mut bytes = Vec::new();
    File::open(path)?
        .take(32 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > 32 * 1024 {
        bail!("Update control file exceeds its size limit");
    }
    Ok(bytes)
}

fn application(layout: &Layout, state: &State) -> PathBuf {
    state.current.as_ref().map_or_else(
        || layout.program.clone(),
        |version| layout.data.join("server-updates/versions").join(version),
    )
}

fn nonce() -> Result<String> {
    let mut bytes = [0; 32];
    getrandom::getrandom(&mut bytes)?;
    Ok(hex::encode(bytes))
}

fn launch(
    layout: &Layout,
    state: &State,
    root: &Path,
    log: Option<&File>,
) -> Result<(Child, String)> {
    let nonce = nonce()?;
    let source = application(layout, state);
    let mut command = node::command_for(layout, &source);
    command
        .env("BMUSTER_DEPLOYMENT", "installed")
        .env("BMUSTER_UPDATE_DATA", root)
        .env("BMUSTER_LAUNCHER_VERSION", env!("CARGO_PKG_VERSION"))
        .env("BMUSTER_LAUNCHER_TARGET", env!("BMUSTER_TARGET"))
        .env("BMUSTER_READINESS_NONCE", &nonce)
        .stdin(Stdio::null());
    if let Some(log) = log {
        command.stdout(log.try_clone()?).stderr(log.try_clone()?);
    }
    let child = command
        .spawn()
        .context("Could not start the bundled Node application")?;
    Ok((child, nonce))
}

impl Supervisor {
    pub fn new(layout: &Layout, log: Option<&File>) -> Result<Self> {
        let root = layout.data.join("server-updates");
        std::fs::create_dir_all(&root)?;
        let lock = File::options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(root.join("launcher.lock"))?;
        lock.try_lock()
            .map_err(|e| anyhow::anyhow!("Another server launcher owns this data folder: {e}"))?;
        let mut state = State::load(&root.join("state.json"))?;
        state.recover();
        state.save(&root.join("state.json"))?;
        cleanup_staging(&root)?;
        let (child, nonce) = launch(layout, &state, &root, log)?;
        Ok(Self {
            layout: layout.clone(),
            root,
            state,
            child,
            nonce,
            ready: false,
            deadline: Instant::now() + Duration::from_secs(120),
            _lock: lock,
            log: log.map(File::try_clone).transpose()?,
        })
    }

    pub fn tick(&mut self) -> Result<()> {
        if !self.ready {
            let ready = std::fs::read(self.root.join("ready.json"))
                .ok()
                .and_then(|bytes| serde_json::from_slice::<Ready>(&bytes).ok());
            let expected = layout::bundle_version(&application(&self.layout, &self.state));
            if ready.is_some_and(|ready| {
                state::validate_nonce(&ready.nonce).is_ok()
                    && ready.nonce == self.nonce
                    && ready.version == expected
                    && ready.process_id == self.child.id()
            }) {
                self.ready = true;
                if self.state.pending.take().is_some() {
                    self.state.phase = "updated".into();
                    self.state.message = format!("Server updated to {expected}");
                    self.state.save(&self.root.join("state.json"))?;
                }
            }
        }
        let exited = self.child.try_wait()?.is_some();
        if exited || (!self.ready && Instant::now() >= self.deadline) {
            if self.state.pending.is_some() {
                self.rollback("The new application did not become ready within two minutes or exited during startup")?;
                return Ok(());
            }
            bail!("The server application exited or did not become ready within two minutes");
        }
        if self.ready && self.root.join("request.json").exists() {
            let request: Request =
                serde_json::from_slice(&read_small(&self.root.join("request.json"))?)?;
            manifest::version(&request.version)?;
            self.state.phase = "downloading".into();
            self.state.message = format!("Checking and downloading {}", request.version);
            self.state.save(&self.root.join("state.json"))?;
            std::fs::remove_file(self.root.join("request.json"))?;
            let result = self.install(&request.version);
            if let Err(error) = result {
                self.state.phase = "failed".into();
                self.state.message = format!("Server update failed: {error:#}");
                self.state.save(&self.root.join("state.json"))?;
                self.clear_preparation()?;
                eprintln!("{}", self.state.message);
            }
        }
        Ok(())
    }

    fn install(&mut self, version: &str) -> Result<()> {
        let current = layout::bundle_version(&application(&self.layout, &self.state));
        download::stage(&self.root, version, &current)?;
        self.state.phase = "preparing".into();
        self.state.message = "Taking a database snapshot and closing sessions".into();
        self.state.save(&self.root.join("state.json"))?;
        state::atomic(
            &self.root.join("prepare.json"),
            &serde_json::to_vec(&serde_json::json!({"nonce": self.nonce}))?,
        )?;
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            let prepared = std::fs::read(self.root.join("prepared.json"))
                .ok()
                .and_then(|bytes| serde_json::from_slice::<Prepared>(&bytes).ok());
            if let Some(prepared) = prepared.filter(|p| p.nonce == self.nonce) {
                if let Some(error) = prepared.error {
                    bail!("Cannot prepare the running application: {error}");
                }
                break;
            }
            if Instant::now() >= deadline || self.child.try_wait()?.is_some() {
                bail!("The application did not acknowledge update preparation");
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        // Persist intent before stopping the old application. A crash at every
        // following step returns to the previous code, never a database restore.
        let previous = self.state.current.clone();
        self.state.previous = previous;
        self.state.current = Some(version.into());
        self.state.pending = Some(version.into());
        self.state.phase = "starting".into();
        self.state.message = format!("Starting server {version}");
        self.state.save(&self.root.join("state.json"))?;
        self.stop_child();
        self.clear_preparation()?;
        match launch(&self.layout, &self.state, &self.root, self.log.as_ref()) {
            Ok((child, nonce)) => {
                self.child = child;
                self.nonce = nonce;
                self.ready = false;
                self.deadline = Instant::now() + Duration::from_secs(120);
            }
            Err(error) => {
                self.rollback(&format!("Cannot start updated application: {error:#}"))?;
            }
        }
        Ok(())
    }

    fn rollback(&mut self, reason: &str) -> Result<()> {
        self.stop_child();
        self.state.current = self.state.previous.take();
        self.state.pending = None;
        self.state.phase = "rolled-back".into();
        self.state.message =
            format!("{reason}. Restored the previous application; the database was retained.");
        self.state.save(&self.root.join("state.json"))?;
        self.clear_preparation()?;
        let (child, nonce) = launch(&self.layout, &self.state, &self.root, self.log.as_ref())?;
        self.child = child;
        self.nonce = nonce;
        self.ready = false;
        self.deadline = Instant::now() + Duration::from_secs(120);
        Ok(())
    }

    fn clear_preparation(&self) -> Result<()> {
        for name in ["prepare.json", "prepared.json"] {
            match std::fs::remove_file(self.root.join(name)) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
        }
        Ok(())
    }
    fn stop_child(&mut self) {
        #[cfg(unix)]
        unsafe {
            libc::kill(self.child.id() as i32, libc::SIGTERM);
        }
        #[cfg(windows)]
        {
            let _ = self.child.kill();
        }
        let deadline = Instant::now() + Duration::from_secs(12);
        while Instant::now() < deadline {
            if self.child.try_wait().ok().flatten().is_some() {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
    pub fn stop(&mut self) {
        self.stop_child();
    }
}
impl Drop for Supervisor {
    fn drop(&mut self) {
        self.stop_child();
    }
}

#[cfg(unix)]
static STOP: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
#[cfg(unix)]
extern "C" fn stop_signal(_: i32) {
    STOP.store(true, std::sync::atomic::Ordering::SeqCst);
}

pub fn run(layout: &Layout) -> Result<()> {
    #[cfg(unix)]
    unsafe {
        libc::signal(
            libc::SIGTERM,
            stop_signal as *const () as libc::sighandler_t,
        );
        libc::signal(libc::SIGINT, stop_signal as *const () as libc::sighandler_t);
    }
    let mut supervisor = Supervisor::new(layout, None)?;
    loop {
        #[cfg(unix)]
        if STOP.load(std::sync::atomic::Ordering::SeqCst) {
            supervisor.stop();
            return Ok(());
        }
        supervisor.tick()?;
        std::thread::sleep(Duration::from_millis(500));
    }
}
