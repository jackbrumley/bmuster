//! Connect-back sockets (SPEC-SESSION-UNITS, Version 2).
//!
//! Nothing of the agent's passes through systemd: no pty path, no pipe and no
//! file descriptor. On Fedora with SELinux enforcing, systemd (`init_t`) may
//! not open the agent's pty, and it refuses the agent's pipes sent over
//! D-Bus. Instead, before the agent starts a transient unit it listens on a
//! socket made for that one unit, and the unit's BMuster program connects
//! back to it:
//!
//! - The socket is `/run/bmuster/connect/<128 random bits>.sock`, `0600` and
//!   owned by the uid the unit runs as, in a `0711` folder the agent owns.
//!   Its path is the only thing the unit is told; it is not a secret.
//! - The agent accepts **one** connection. The listening socket is removed
//!   as soon as it is accepted, or after [`CONNECT_WAIT`] if nobody came.
//! - The peer is checked with `SO_PEERCRED`: its uid must be the unit's and
//!   `/proc/<pid>/cgroup` must name exactly the unit the agent started.
//!   Anything else is closed and logged, and the session fails.

use super::unit::Manager;
use anyhow::{bail, Context as _, Result};
use std::fs;
use std::io::{self, BufRead as _, BufReader};
use std::os::fd::AsRawFd as _;
use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// How long a unit gets to connect back.
pub const CONNECT_WAIT: Duration = Duration::from_secs(10);
/// The system agent's folder (its `RuntimeDirectory=bmuster` is writable
/// inside its sandbox).
const SYSTEM_FOLDER: &str = "/run/bmuster/connect";
const FOLDER_MODE: u32 = 0o711;
const SOCKET_MODE: u32 = 0o600;
/// How much of `systemd-run`'s own messages an error quotes.
const MAX_SAID: usize = 2048;

fn effective_uid() -> u32 {
    // SAFETY: geteuid has no arguments and cannot fail.
    unsafe { libc::geteuid() }
}

/// The folder the sockets are made in: owned by the agent, `0711`, so the
/// unit's program can reach a socket whose name it was given but nobody
/// can list the others.
#[derive(Debug, Clone)]
pub struct Folder(PathBuf);

impl Folder {
    /// The installed agent's folder.
    pub fn system() -> Folder {
        Folder(PathBuf::from(SYSTEM_FOLDER))
    }

    /// The folder for units of `manager`. A development agent using the
    /// user manager is not root and cannot write to /run/bmuster.
    pub fn for_manager(manager: Manager) -> Result<Folder> {
        match manager {
            Manager::System => Ok(Folder::system()),
            #[cfg(debug_assertions)]
            Manager::User => {
                let runtime = std::env::var_os("XDG_RUNTIME_DIR")
                    .context("XDG_RUNTIME_DIR is not set, so user units have no socket folder")?;
                Ok(Folder(PathBuf::from(runtime).join("bmuster-connect")))
            }
        }
    }

    #[cfg(test)]
    pub fn at(path: &Path) -> Folder {
        Folder(path.to_path_buf())
    }

    /// Makes the folder if it is missing and holds it to its rules.
    fn prepare(&self) -> Result<()> {
        match fs::create_dir(&self.0) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
            Err(e) => {
                return Err(e).with_context(|| format!("could not create {}", self.0.display()))
            }
        }
        let metadata = fs::symlink_metadata(&self.0)
            .with_context(|| format!("could not inspect {}", self.0.display()))?;
        if !metadata.is_dir() {
            bail!("{} is not a folder", self.0.display());
        }
        if metadata.uid() != effective_uid() {
            bail!(
                "{} belongs to uid {}, not to the agent",
                self.0.display(),
                metadata.uid()
            );
        }
        if metadata.mode() & 0o7777 != FOLDER_MODE {
            fs::set_permissions(&self.0, fs::Permissions::from_mode(FOLDER_MODE))
                .with_context(|| format!("could not set the mode of {}", self.0.display()))?;
        }
        Ok(())
    }

    /// Removes sockets an earlier run left behind (it was killed while a
    /// unit was starting).
    pub fn sweep(&self) {
        let Ok(entries) = fs::read_dir(&self.0) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path
                .extension()
                .is_some_and(|extension| extension == "sock")
            {
                if let Err(e) = fs::remove_file(&path) {
                    log::warn!("Could not remove {}: {e}", path.display());
                }
            }
        }
    }
}

/// Who may connect: the unit's uid, from inside exactly the unit.
#[derive(Debug, Clone)]
pub struct Peer {
    uid: u32,
    unit: String,
    manager: Manager,
}

impl Peer {
    /// `unit` with or without `.service` (systemd-run adds it).
    pub fn new(uid: u32, unit: &str, manager: Manager) -> Peer {
        let unit = if unit.ends_with(".service") {
            unit.to_string()
        } else {
            format!("{unit}.service")
        };
        Peer { uid, unit, manager }
    }

    /// True when `path` (a cgroup path) is exactly this unit's.
    fn is_the_unit(&self, path: &str) -> bool {
        match self.manager {
            Manager::System => path == format!("/system.slice/{}", self.unit),
            #[cfg(debug_assertions)]
            Manager::User => {
                let base = format!(
                    "/user.slice/user-{uid}.slice/user@{uid}.service/",
                    uid = self.uid
                );
                let Some(rest) = path.strip_prefix(&base) else {
                    return false;
                };
                let mut parts: Vec<&str> = rest.split('/').collect();
                parts.pop() == Some(self.unit.as_str())
                    && parts.iter().all(|part| part.ends_with(".slice"))
            }
        }
    }

    /// Checks a `/proc/<pid>/cgroup` text: every systemd hierarchy line
    /// (the unified `0::` one, or v1's `name=systemd`) must name the unit.
    fn in_the_unit(&self, cgroup: &str) -> Result<(), String> {
        let mut seen = Vec::new();
        for line in cgroup.lines() {
            let mut fields = line.splitn(3, ':');
            let (Some(hierarchy), Some(controllers), Some(path)) =
                (fields.next(), fields.next(), fields.next())
            else {
                continue;
            };
            let systemd =
                (hierarchy == "0" && controllers.is_empty()) || controllers == "name=systemd";
            if systemd {
                seen.push(path);
            }
        }
        if seen.is_empty() {
            return Err("its cgroup names no systemd unit".into());
        }
        match seen.iter().find(|path| !self.is_the_unit(path)) {
            Some(other) => Err(format!("it runs in {other}, not in {}", self.unit)),
            None => Ok(()),
        }
    }
}

/// The peer's pid and uid, from the kernel.
fn peer_credentials(stream: &UnixStream) -> io::Result<(libc::pid_t, u32)> {
    let mut credentials = libc::ucred {
        pid: 0,
        uid: 0,
        gid: 0,
    };
    let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY: SO_PEERCRED writes one ucred into the buffer we own.
    let status = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            std::ptr::addr_of_mut!(credentials).cast(),
            &mut length,
        )
    };
    if status != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok((credentials.pid, credentials.uid))
}

fn proc_cgroup(pid: libc::pid_t) -> io::Result<String> {
    fs::read_to_string(format!("/proc/{pid}/cgroup"))
}

/// One unit's listening socket.
#[derive(Debug)]
pub struct ConnectSocket {
    path: PathBuf,
    listener: Option<UnixListener>,
    removed: bool,
}

impl ConnectSocket {
    /// Makes a fresh socket in `folder` that only `owner` (and root) may
    /// connect to.
    pub fn create(folder: &Folder, owner: u32) -> Result<ConnectSocket> {
        folder.prepare()?;
        let mut bytes = [0u8; 16];
        getrandom::getrandom(&mut bytes).context("could not make a socket name")?;
        let path = folder.0.join(format!("{}.sock", hex::encode(bytes)));
        let listener = UnixListener::bind(&path)
            .with_context(|| format!("could not listen on {}", path.display()))?;
        // From here the socket file is removed when this value goes.
        let socket = ConnectSocket {
            path,
            listener: Some(listener),
            removed: false,
        };
        fs::set_permissions(&socket.path, fs::Permissions::from_mode(SOCKET_MODE))
            .with_context(|| format!("could not set the mode of {}", socket.path.display()))?;
        std::os::unix::fs::chown(&socket.path, Some(owner), None)
            .with_context(|| format!("could not give {} to uid {owner}", socket.path.display()))?;
        if let Some(listener) = &socket.listener {
            listener.set_nonblocking(true)?;
        }
        Ok(socket)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn remove(&mut self) {
        if std::mem::replace(&mut self.removed, true) {
            return;
        }
        if let Err(e) = fs::remove_file(&self.path) {
            if e.kind() != io::ErrorKind::NotFound {
                log::warn!("Could not remove {}: {e}", self.path.display());
            }
        }
    }

    /// Waits up to `wait` for the one connection and checks it is `peer`.
    /// `gone` says why waiting is pointless (the unit already ended).
    pub fn accept(
        self,
        peer: &Peer,
        wait: Duration,
        gone: &mut dyn FnMut() -> Option<String>,
    ) -> Result<UnixStream> {
        self.accept_checked(peer, wait, gone, &proc_cgroup)
    }

    /// [`accept`](Self::accept) with the cgroup reader given (tests).
    pub fn accept_checked(
        mut self,
        peer: &Peer,
        wait: Duration,
        gone: &mut dyn FnMut() -> Option<String>,
        cgroup: &dyn Fn(libc::pid_t) -> io::Result<String>,
    ) -> Result<UnixStream> {
        let listener = self
            .listener
            .take()
            .context("the socket was already used")?;
        let deadline = Instant::now() + wait;
        let stream = loop {
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => {}
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(e) => {
                    self.remove();
                    return Err(e).context("could not accept the session helper's connection");
                }
            }
            if let Some(reason) = gone() {
                self.remove();
                bail!("The session's helper did not connect: {reason}");
            }
            if Instant::now() >= deadline {
                self.remove();
                bail!(
                    "The session's helper did not connect within {} s",
                    wait.as_secs()
                );
            }
            let mut poll = libc::pollfd {
                fd: listener.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            // SAFETY: one pollfd we own; a timeout or EINTR just loops.
            unsafe {
                libc::poll(&mut poll, 1, 50);
            }
        };
        // One connection only: nobody else can reach this unit's socket.
        self.remove();
        drop(listener);
        stream.set_nonblocking(false)?;
        let checked = peer_credentials(&stream)
            .map_err(|e| format!("its credentials could not be read: {e}"))
            .and_then(|(pid, uid)| {
                if uid != peer.uid {
                    return Err(format!("pid {pid} runs as uid {uid}, not {}", peer.uid));
                }
                let text = cgroup(pid).map_err(|e| format!("pid {pid}'s cgroup: {e}"))?;
                peer.in_the_unit(&text)
                    .map_err(|reason| format!("pid {pid}: {reason}"))
            });
        match checked {
            Ok(()) => Ok(stream),
            Err(reason) => {
                log::warn!("Refused a connection meant for {}: {reason}", peer.unit);
                let _ = stream.shutdown(std::net::Shutdown::Both);
                bail!("The session's helper did not pass the peer check: {reason}")
            }
        }
    }
}

impl Drop for ConnectSocket {
    fn drop(&mut self) {
        self.remove();
    }
}

/// `systemd-run`'s own messages: shipped as the helper's lines and kept for
/// an error.
struct Said {
    text: Arc<Mutex<String>>,
    reader: Option<JoinHandle<()>>,
}

impl Said {
    fn collect(helper: &'static str, stderr: Option<std::process::ChildStderr>) -> Said {
        let text = Arc::new(Mutex::new(String::new()));
        let reader = stderr.and_then(|stderr| {
            let text = Arc::clone(&text);
            std::thread::Builder::new()
                .name(format!("{helper} systemd-run"))
                .spawn(move || {
                    for line in BufReader::new(stderr).lines() {
                        let Ok(line) = line else {
                            return;
                        };
                        let line = line.trim_end();
                        if line.is_empty() {
                            continue;
                        }
                        crate::logging::helper_line(&crate::logging::SHIP, helper, line);
                        let mut kept = text.lock().unwrap_or_else(|p| p.into_inner());
                        if kept.len() < MAX_SAID {
                            if !kept.is_empty() {
                                kept.push(' ');
                            }
                            kept.push_str(line);
                        }
                    }
                })
                .ok()
        });
        Said { text, reader }
    }

    /// Everything it said, once its stderr closed.
    fn finish(mut self) -> String {
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
        let text = self.text.lock().unwrap_or_else(|p| p.into_inner());
        text.clone()
    }
}

/// A started unit that connected back.
pub struct Connected {
    /// `systemd-run --wait`, which ends when the unit does.
    pub systemd_run: Child,
    pub stream: UnixStream,
}

/// Runs `systemd_run` (which starts `peer`'s unit with nothing of the
/// agent's: null stdin and stdout, its stderr shipped under `helper`) and
/// waits for the unit to connect to `socket`. On any failure the unit is
/// stopped and the error carries what `systemd-run` said.
pub fn start(
    socket: ConnectSocket,
    peer: &Peer,
    mut systemd_run: Command,
    helper: &'static str,
    stop: &AtomicBool,
) -> Result<Connected> {
    let mut child = systemd_run
        .current_dir("/")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .with_context(|| format!("could not run systemd-run for the {helper}"))?;
    let said = Said::collect(helper, child.stderr.take());
    let accepted = socket.accept(peer, CONNECT_WAIT, &mut || {
        if stop.load(Ordering::SeqCst) {
            return Some("the session ended".into());
        }
        match child.try_wait() {
            Ok(Some(status)) => Some(format!("systemd-run exited with {status}")),
            Ok(None) => None,
            Err(e) => Some(format!("systemd-run could not be checked: {e}")),
        }
    });
    match accepted {
        Ok(stream) => Ok(Connected {
            systemd_run: child,
            stream,
        }),
        Err(error) => {
            super::unit::stop_units(peer.manager, &[peer.unit.as_str()]);
            let _ = child.kill();
            let _ = child.wait();
            let said = said.finish();
            if said.is_empty() {
                Err(error)
            } else {
                Err(error.context(format!("systemd-run said: {said}")))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const UNIT: &str = "bmuster-terminal-0b0e8c1e.service";

    fn mode(path: &Path) -> u32 {
        fs::symlink_metadata(path).unwrap().mode() & 0o7777
    }

    fn unit_cgroup(_: libc::pid_t) -> io::Result<String> {
        Ok(format!("0::/system.slice/{UNIT}\n"))
    }

    fn never() -> Option<String> {
        None
    }

    /// Connects to `path` from another thread, as the unit's program does.
    fn connect_from_thread(path: &Path) -> std::thread::JoinHandle<UnixStream> {
        let path = path.to_path_buf();
        std::thread::spawn(move || UnixStream::connect(path).unwrap())
    }

    fn system_peer(uid: u32) -> Peer {
        Peer::new(uid, UNIT, Manager::System)
    }

    #[test]
    fn socket_lifecycle() {
        let dir = tempfile::tempdir().unwrap();
        let folder_path = dir.path().join("connect");
        fs::create_dir(&folder_path).unwrap();
        fs::set_permissions(&folder_path, fs::Permissions::from_mode(0o755)).unwrap();
        let folder = Folder::at(&folder_path);
        let me = effective_uid();

        let socket = ConnectSocket::create(&folder, me).unwrap();
        assert_eq!(mode(&folder_path), 0o711, "the folder is held to 0711");
        let path = socket.path().to_path_buf();
        assert_eq!(path.parent(), Some(folder_path.as_path()));
        let name = path.file_name().unwrap().to_str().unwrap();
        assert_eq!(name.len(), 32 + ".sock".len(), "128 random bits");
        assert_eq!(mode(&path), 0o600);
        assert_eq!(fs::symlink_metadata(&path).unwrap().uid(), me);
        let other = ConnectSocket::create(&folder, me).unwrap();
        assert_ne!(other.path(), path, "one socket per session");

        // Removed as soon as the connection is accepted.
        let client = connect_from_thread(&path);
        let stream = socket
            .accept_checked(&system_peer(me), CONNECT_WAIT, &mut never, &unit_cgroup)
            .unwrap();
        assert!(!path.exists());
        drop((stream, client.join().unwrap()));

        // Removed when nobody connects in time.
        let other_path = other.path().to_path_buf();
        let error = other
            .accept_checked(
                &system_peer(me),
                Duration::from_millis(200),
                &mut never,
                &unit_cgroup,
            )
            .unwrap_err();
        assert!(format!("{error}").contains("did not connect"), "{error}");
        assert!(!other_path.exists());

        // And when the unit is gone before it connected.
        let third = ConnectSocket::create(&folder, me).unwrap();
        let third_path = third.path().to_path_buf();
        let error = third
            .accept_checked(
                &system_peer(me),
                CONNECT_WAIT,
                &mut || Some("systemd-run exited with exit status: 1".into()),
                &unit_cgroup,
            )
            .unwrap_err();
        assert!(format!("{error}").contains("systemd-run exited"), "{error}");
        assert!(!third_path.exists());

        // A folder that is not the agent's own is refused.
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&folder_path, &link).unwrap();
        assert!(ConnectSocket::create(&Folder::at(&link), me).is_err());

        // Leftovers from a killed agent are swept.
        let left = ConnectSocket::create(&folder, me).unwrap();
        let left_path = left.path().to_path_buf();
        std::mem::forget(left);
        assert!(left_path.exists());
        folder.sweep();
        assert!(!left_path.exists());
    }

    fn attempt(peer: &Peer, cgroup: &dyn Fn(libc::pid_t) -> io::Result<String>) -> Result<()> {
        let dir = tempfile::tempdir().unwrap();
        let socket = ConnectSocket::create(&Folder::at(dir.path()), effective_uid()).unwrap();
        let client = connect_from_thread(socket.path());
        let accepted = socket.accept_checked(peer, CONNECT_WAIT, &mut never, cgroup);
        let mut client = client.join().unwrap();
        match accepted {
            Ok(_) => Ok(()),
            Err(error) => {
                // The refused peer's connection is closed.
                use std::io::Read as _;
                let mut byte = [0u8; 1];
                assert_eq!(client.read(&mut byte).unwrap_or(0), 0);
                Err(error)
            }
        }
    }

    #[test]
    fn peer_must_be_the_unit() {
        let me = effective_uid();
        assert!(attempt(&system_peer(me), &unit_cgroup).is_ok());

        let error = attempt(&system_peer(me.wrapping_add(1)), &unit_cgroup).unwrap_err();
        assert!(format!("{error}").contains("peer check"), "{error}");
        assert!(format!("{error}").contains("uid"), "{error}");

        for wrong in [
            "0::/system.slice/bmuster-terminal-other.service\n".to_string(),
            format!("0::/system.slice/{UNIT}/inner\n"),
            format!("0::/system.slice/evil-{UNIT}\n"),
            format!("0::/user.slice/{UNIT}\n"),
            "12:cpu:/\n".to_string(),
            format!("1:name=systemd:/system.slice/sshd.service\n0::/system.slice/{UNIT}\n"),
        ] {
            let error = attempt(&system_peer(me), &|_| Ok(wrong.clone())).unwrap_err();
            assert!(
                format!("{error}").contains("peer check"),
                "{wrong}: {error}"
            );
        }
        let unreadable = attempt(&system_peer(me), &|_| {
            Err(io::Error::from(io::ErrorKind::NotFound))
        });
        assert!(unreadable.is_err());

        // cgroup v1 (hybrid) names the unit on the name=systemd line.
        let hybrid =
            format!("4:memory:/system.slice/{UNIT}\n1:name=systemd:/system.slice/{UNIT}\n");
        assert!(attempt(&system_peer(me), &|_| Ok(hybrid.clone())).is_ok());
        // `.service` is added when the name has none.
        assert!(attempt(
            &Peer::new(me, "bmuster-terminal-0b0e8c1e", Manager::System),
            &unit_cgroup
        )
        .is_ok());
    }

    #[cfg(debug_assertions)]
    #[test]
    fn user_units_live_under_the_users_manager() {
        let peer = Peer::new(1000, UNIT, Manager::User);
        assert!(peer
            .in_the_unit(&format!(
                "0::/user.slice/user-1000.slice/user@1000.service/app.slice/{UNIT}"
            ))
            .is_ok());
        assert!(peer
            .in_the_unit(&format!(
                "0::/user.slice/user-1000.slice/user@1000.service/{UNIT}"
            ))
            .is_ok());
        assert!(peer
            .in_the_unit(&format!(
                "0::/user.slice/user-1001.slice/user@1001.service/app.slice/{UNIT}"
            ))
            .is_err());
        assert!(peer
            .in_the_unit(&format!(
                "0::/user.slice/user-1000.slice/user@1000.service/app.slice/x.service/{UNIT}"
            ))
            .is_err());
    }
}
