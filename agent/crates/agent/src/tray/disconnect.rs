//! Disconnect from the tray on Linux (SPEC-DESKTOP 8.2, notice version 2).
//!
//! The tray helper runs as the signed-in person and cannot end sessions
//! itself, so the agent listens on `disconnect.sock` in its root-owned
//! runtime folder (`/run/bmuster`). The socket is open to every local
//! account, but the agent reads the caller's uid from the kernel
//! (`SO_PEERCRED`) and acts only for the person at this machine's screen:
//! the user of the active, local, graphical session on `seat0`, as logind
//! records it. That is exactly who can press the notice bar's Disconnect.
//! Anyone else is told `refused` before a byte is read; the person at the
//! screen is told `ready` and may then send the one request,
//! `disconnect`, which does what the bar's button does: every desktop
//! session ends with `disconnected-at-machine`.

use super::starter::{fields, session_user, SESSIONS_DIR};
use anyhow::{bail, Context as _, Result};
use std::io::{Read as _, Write as _};
use std::os::fd::AsRawFd as _;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::time::Duration;

/// The socket's name in the status folder.
pub const SOCKET: &str = "disconnect.sock";
const REQUEST: &[u8] = b"disconnect\n";
const REFUSED: &str = "refused\n";
/// The agent's first word to someone at the screen.
const READY: &str = "ready\n";
/// How long either side waits on the other.
const WAIT: Duration = Duration::from_secs(2);

/// The uids at this machine's screen: users of the active, local, graphical
/// session on `seat0` (from logind's session records).
pub fn screen_uids<'a>(records: impl IntoIterator<Item = &'a str>) -> Vec<u32> {
    let mut uids: Vec<u32> = records
        .into_iter()
        .filter(|text| {
            let fields = fields(text);
            fields.get("SEAT") == Some(&"seat0")
                && fields.get("ACTIVE") == Some(&"1")
                && fields.get("REMOTE") != Some(&"1")
        })
        .filter_map(session_user)
        .map(|user| user.uid)
        .collect();
    uids.sort_unstable();
    uids.dedup();
    uids
}

/// [`screen_uids`] from the records in `dir`.
fn read_screen_uids(dir: &Path) -> Vec<u32> {
    let records: Vec<String> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .filter_map(|entry| std::fs::read_to_string(entry.path()).ok())
        .collect();
    screen_uids(records.iter().map(String::as_str))
}

/// The uid of the process at the other end, from the kernel.
fn peer_uid(stream: &UnixStream) -> std::io::Result<u32> {
    let mut credentials = libc::ucred {
        pid: 0,
        uid: 0,
        gid: 0,
    };
    let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY: the descriptor is open for the call, and `credentials` and
    // `length` are valid for writes of the size passed.
    let result = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&mut credentials as *mut libc::ucred).cast(),
            &mut length,
        )
    };
    if result != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(credentials.uid)
}

/// Answers one caller: refuses anyone not at the screen before reading,
/// then runs `disconnect` for a well-formed request.
fn handle(
    mut stream: UnixStream,
    at_screen: &dyn Fn() -> Vec<u32>,
    disconnect: &mut dyn FnMut() -> usize,
) -> std::io::Result<()> {
    stream.set_read_timeout(Some(WAIT))?;
    stream.set_write_timeout(Some(WAIT))?;
    let uid = peer_uid(&stream)?;
    if !at_screen().contains(&uid) {
        log::warn!("Tray Disconnect refused: uid {uid} is not at this machine's screen");
        return stream.write_all(REFUSED.as_bytes());
    }
    stream.write_all(READY.as_bytes())?;
    let mut request = Vec::new();
    (&mut stream)
        .take(REQUEST.len() as u64)
        .read_to_end(&mut request)?;
    if request != REQUEST {
        log::warn!("Tray Disconnect refused: uid {uid} sent an unknown request");
        return stream.write_all(REFUSED.as_bytes());
    }
    log::warn!("Disconnect pressed in the tray by uid {uid}");
    let ended = disconnect();
    stream.write_all(format!("ended {ended}\n").as_bytes())
}

/// Listens on `dir`/[`SOCKET`] on a thread of its own.
fn listen(
    dir: &Path,
    at_screen: impl Fn() -> Vec<u32> + Send + 'static,
    mut disconnect: impl FnMut() -> usize + Send + 'static,
) -> Result<()> {
    use std::os::unix::fs::PermissionsExt as _;
    let path = dir.join(SOCKET);
    match std::fs::remove_file(&path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error).context("could not remove the old Disconnect socket"),
    }
    let listener = UnixListener::bind(&path)
        .with_context(|| format!("could not listen on {}", path.display()))?;
    // Anyone may connect; `handle` decides who is answered.
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o666))?;
    std::thread::Builder::new()
        .name("tray disconnect".into())
        .spawn(move || {
            for stream in listener.incoming() {
                let result = stream.and_then(|stream| handle(stream, &at_screen, &mut disconnect));
                if let Err(error) = result {
                    log::warn!("Tray Disconnect request failed: {error}");
                }
            }
        })?;
    Ok(())
}

/// Starts the agent's side: Disconnect from the tray ends every desktop
/// session through the notice board, as the bar's button does.
pub fn serve(dir: &Path) -> Result<()> {
    listen(
        dir,
        || read_screen_uids(Path::new(SESSIONS_DIR)),
        bmuster_desktop::notice::disconnect_all,
    )
}

/// One line from `stream`, newline kept, at most 32 bytes.
fn read_line(stream: &mut UnixStream) -> std::io::Result<String> {
    let mut line = Vec::new();
    let mut byte = [0u8; 1];
    while line.len() < 32 && line.last() != Some(&b'\n') {
        if stream.read(&mut byte)? == 0 {
            break;
        }
        line.push(byte[0]);
    }
    Ok(String::from_utf8_lossy(&line).into_owned())
}

/// Sends `disconnect` to the socket at `path`; how many sessions ended.
fn exchange(path: &Path) -> Result<usize> {
    let mut stream = UnixStream::connect(path)
        .with_context(|| format!("could not reach the agent at {}", path.display()))?;
    stream.set_read_timeout(Some(WAIT))?;
    stream.set_write_timeout(Some(WAIT))?;
    // The agent speaks first: `ready`, or `refused` for anyone not at the
    // screen (then it closes without reading).
    let greeting = read_line(&mut stream)?;
    let reply = if greeting == READY {
        stream.write_all(REQUEST)?;
        read_line(&mut stream)?
    } else {
        greeting
    };
    match reply.strip_prefix("ended ").map(str::trim_end) {
        Some(count) => count.parse().context("the agent's answer is malformed"),
        None if reply == REFUSED => {
            bail!("The agent only takes Disconnect from the person signed in at this screen")
        }
        None => bail!("The agent's answer is malformed"),
    }
}

/// The tray's side: asks the agent to end every desktop session. The
/// socket is used only in a folder root owns and nobody else can write.
pub fn request(dir: &Path) -> Result<usize> {
    use std::os::unix::fs::{FileTypeExt as _, MetadataExt as _};
    let folder = std::fs::symlink_metadata(dir)?;
    if !folder.is_dir() || folder.uid() != 0 || folder.mode() & 0o022 != 0 {
        bail!("The agent's runtime folder is not protected by root");
    }
    let path = dir.join(SOCKET);
    let socket = std::fs::symlink_metadata(&path)?;
    if !socket.file_type().is_socket() || socket.uid() != 0 {
        bail!("The Disconnect socket is not the agent's");
    }
    exchange(&path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use bmuster_desktop::{notice, EndReason, Incoming};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn record(uid: u32, seat: &str, active: &str, remote: &str) -> String {
        format!(
            "UID={uid}\nUSER=user{uid}\nACTIVE={active}\nSTATE=active\nREMOTE={remote}\nTYPE=wayland\nCLASS=user\nSEAT={seat}\n"
        )
    }

    fn own_uid() -> u32 {
        // SAFETY: getuid has no arguments and cannot fail.
        unsafe { libc::getuid() }
    }

    #[test]
    fn tray_disconnect_is_for_the_person_at_the_screen_only() {
        let records = [
            record(1000, "seat0", "1", "0"),
            // Switched away (fast user switching): not on the screen.
            record(1001, "seat0", "0", "0"),
            // Signed in over the network, or on another seat.
            record(1002, "seat0", "1", "1"),
            record(1003, "seat1", "1", "0"),
            // A sign-in screen's account.
            "UID=42\nUSER=gdm\nACTIVE=1\nSTATE=active\nTYPE=wayland\nCLASS=greeter\nSEAT=seat0\n"
                .to_string(),
        ];
        assert_eq!(screen_uids(records.iter().map(String::as_str)), [1000]);
        assert!(screen_uids([]).is_empty());
    }

    #[test]
    fn tray_disconnect_refuses_a_caller_not_at_the_screen() {
        let dir = tempfile::tempdir().unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&calls);
        listen(dir.path(), Vec::new, move || {
            counted.fetch_add(1, Ordering::SeqCst);
            1
        })
        .unwrap();
        let error = exchange(&dir.path().join(SOCKET)).unwrap_err();
        assert!(
            error.to_string().contains("signed in at this screen"),
            "{error:#}"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 0, "nothing was ended");
    }

    #[test]
    fn tray_disconnect_ignores_anything_but_its_one_request() {
        let dir = tempfile::tempdir().unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let counted = Arc::clone(&calls);
        listen(
            dir.path(),
            || vec![own_uid()],
            move || {
                counted.fetch_add(1, Ordering::SeqCst);
                1
            },
        )
        .unwrap();
        let mut stream = UnixStream::connect(dir.path().join(SOCKET)).unwrap();
        stream.write_all(b"reboot-now\n").unwrap();
        let mut reply = String::new();
        stream.read_to_string(&mut reply).unwrap();
        assert_eq!(reply, format!("{READY}{REFUSED}"));
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    /// The tray's Disconnect reaches the notice board's: the viewer's
    /// session is told `disconnected-at-machine`, as by the bar's button.
    #[test]
    fn tray_disconnect_ends_desktop_sessions_through_the_notice_board() {
        let dir = tempfile::tempdir().unwrap();
        listen(
            dir.path(),
            || vec![own_uid()],
            bmuster_desktop::notice::disconnect_all,
        )
        .unwrap();
        let (end, inbox) = std::sync::mpsc::channel();
        let shown = notice::show(None, "Kim", end);
        let ended = exchange(&dir.path().join(SOCKET)).unwrap();
        assert!(ended >= 1, "at least Kim's session was told");
        assert_eq!(
            inbox.recv_timeout(Duration::from_secs(5)),
            Ok(Incoming::End(EndReason::DisconnectedAtMachine))
        );
        drop(shown);
    }

    #[test]
    fn tray_disconnect_request_needs_a_root_owned_folder() {
        let dir = tempfile::tempdir().unwrap();
        listen(dir.path(), || vec![own_uid()], || 0).unwrap();
        // The test runs unprivileged, so its folder is not root's.
        assert!(request(dir.path()).is_err());
    }
}
