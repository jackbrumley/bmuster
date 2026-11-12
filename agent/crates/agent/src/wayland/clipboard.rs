//! Copy and paste for Wayland portal sessions (SPEC-DESKTOP 21.9).
//!
//! Two halves:
//!
//! - **The agent's side** ([`Replies`]): a clipboard call on the session
//!   thread sends a numbered command to the helper and waits, at most
//!   [`AGENT_WAIT`], for the answer with the same number. The frames
//!   thread hands answers over; one that comes too late is dropped.
//! - **The helper's side** ([`PortalClipboard`]): the RemoteDesktop
//!   portal's Clipboard interface, behind the [`Portal`] trait so tests
//!   can stand in for the desktop. A push offers the text
//!   (`SetSelection`) and writes it to each program that pastes it
//!   (`SelectionTransfer`, `SelectionWrite`); a pull reads the current
//!   selection (`SelectionRead`) in the best text type the owner offers.
//!   Reads and writes go through non-blocking pipes with a time limit,
//!   so a stuck program never holds the helper's input.
//!
//! Neither half ever logs the text.

use anyhow::{anyhow, bail, Result};
use ashpd::desktop::{clipboard::Clipboard, remote_desktop::RemoteDesktop, Session};
use bmuster_desktop::clipboard::CLIPBOARD_WAIT;
use bmuster_desktop::control::MAX_CLIPBOARD_BYTES;
use bmuster_desktop::input::{InputError, InputResult};
use std::collections::HashMap;
use std::io::{Read as _, Write as _};
use std::os::fd::OwnedFd;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, SyncSender};
use std::sync::{Mutex, PoisonError};
use std::time::Duration;
use tokio::io::unix::AsyncFd;

/// What a push offers, best first.
pub(crate) const OFFERED: [&str; 3] = ["text/plain;charset=utf-8", "UTF8_STRING", "text/plain"];

/// What a pull asks for, best first.
pub(crate) const WANTED: [&str; 3] = ["text/plain;charset=utf-8", "text/plain", "UTF8_STRING"];

/// How long the agent waits for the helper: longer than the helper's own
/// limit, so the helper's reason arrives first.
pub(crate) const AGENT_WAIT: Duration = Duration::from_secs(CLIPBOARD_WAIT.as_secs() + 2);

/// What the desktop says when clipboard access was not granted.
pub(crate) const NOT_ALLOWED: &str =
    "The desktop did not allow copy and paste for this session. On KDE Plasma it needs 6.5.3 or later.";

/// The helper's answer to one clipboard command.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Reply {
    Set,
    Text(String),
    Failed(String),
}

/// The agent's clipboard calls waiting for the helper's answers.
pub(crate) struct Replies {
    next: AtomicU64,
    /// `None` once the helper has gone: every call fails at once.
    waiting: Mutex<Option<HashMap<u64, SyncSender<Reply>>>>,
}

impl Default for Replies {
    fn default() -> Self {
        Self {
            next: AtomicU64::new(1),
            waiting: Mutex::new(Some(HashMap::new())),
        }
    }
}

fn helper_gone() -> InputError {
    InputError("The Wayland helper has stopped; copy and paste is unavailable.".into())
}

impl Replies {
    /// Sends the command `send` builds for a fresh id and waits up to
    /// `wait` for its answer.
    pub(crate) fn ask(
        &self,
        wait: Duration,
        send: impl FnOnce(u64) -> InputResult<()>,
    ) -> InputResult<Reply> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (answer, answered) = mpsc::sync_channel(1);
        match self
            .waiting
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_mut()
        {
            Some(waiting) => waiting.insert(id, answer),
            None => return Err(helper_gone()),
        };
        let result = send(id).and_then(|()| match answered.recv_timeout(wait) {
            Ok(reply) => Ok(reply),
            Err(RecvTimeoutError::Timeout) => Err(InputError(format!(
                "The machine's clipboard did not answer within {} s",
                wait.as_secs()
            ))),
            Err(RecvTimeoutError::Disconnected) => Err(helper_gone()),
        });
        if let Some(waiting) = self
            .waiting
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_mut()
        {
            waiting.remove(&id);
        }
        result
    }

    /// Hands `reply` to the call waiting for `id`; a late answer, for a
    /// call that gave up, is dropped.
    pub(crate) fn deliver(&self, id: u64, reply: Reply) {
        let waiting = self.waiting.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(answer) = waiting.as_ref().and_then(|waiting| waiting.get(&id)) {
            let _ = answer.try_send(reply);
        }
    }

    /// The helper has gone: waiting calls end now, later ones at once.
    pub(crate) fn close(&self) {
        self.waiting
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
    }
}

/// The calls [`PortalClipboard`] makes on the desktop's Clipboard portal,
/// for the one RemoteDesktop session the helper owns.
pub(crate) trait Portal {
    async fn set_selection(&self, mime_types: &[&str]) -> Result<()>;
    async fn selection_write(&self, serial: u32) -> Result<OwnedFd>;
    async fn selection_write_done(&self, serial: u32, success: bool) -> Result<()>;
    async fn selection_read(&self, mime_type: &str) -> Result<OwnedFd>;
}

/// Who owns the desktop's clipboard, as far as the helper has been told.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Selection {
    /// Nothing heard yet (the selection predates the session).
    Unknown,
    /// This session's push.
    Ours,
    /// Another program, offering these types.
    Other(Vec<String>),
}

struct Holder {
    /// The pushed text, kept only while this session owns the clipboard.
    offered: Option<String>,
    selection: Selection,
}

/// The helper's clipboard for one portal session.
pub(crate) struct PortalClipboard<P> {
    portal: P,
    holder: Mutex<Holder>,
}

fn timed_out() -> anyhow::Error {
    anyhow!(
        "The machine's clipboard did not answer within {} s",
        CLIPBOARD_WAIT.as_secs()
    )
}

impl<P: Portal> PortalClipboard<P> {
    pub(crate) fn new(portal: P) -> Self {
        Self {
            portal,
            holder: Mutex::new(Holder {
                offered: None,
                selection: Selection::Unknown,
            }),
        }
    }

    fn holder(&self) -> std::sync::MutexGuard<'_, Holder> {
        self.holder.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Offers `text` as the desktop's clipboard.
    pub(crate) async fn set(&self, text: String) -> Result<()> {
        if text.len() > MAX_CLIPBOARD_BYTES {
            bail!("clipboard text is over 1 MB");
        }
        self.holder().offered = Some(text);
        let result = tokio::time::timeout(CLIPBOARD_WAIT, self.portal.set_selection(&OFFERED))
            .await
            .unwrap_or_else(|_| Err(timed_out()));
        let mut holder = self.holder();
        match result {
            Ok(()) => holder.selection = Selection::Ours,
            Err(_) => holder.offered = None,
        }
        result
    }

    /// The portal says the clipboard changed hands. Once another program
    /// takes it, the pushed text is forgotten: it may be a secret.
    pub(crate) fn owner_changed(&self, session_is_owner: Option<bool>, mime_types: Vec<String>) {
        let mut holder = self.holder();
        if session_is_owner == Some(true) {
            holder.selection = Selection::Ours;
            return;
        }
        // A change heard before this session's own push took effect says
        // nothing about that push, so only a loss of ownership drops it.
        if holder.selection == Selection::Ours {
            holder.offered = None;
        }
        holder.selection = Selection::Other(mime_types);
    }

    /// A program pastes: writes the pushed text for `serial`, if this
    /// session offered `mime_type`, and tells the portal how it went.
    pub(crate) async fn transfer(&self, mime_type: &str, serial: u32) -> Result<()> {
        let text = OFFERED
            .contains(&mime_type)
            .then(|| self.holder().offered.clone())
            .flatten();
        let written = match text {
            Some(text) => tokio::time::timeout(CLIPBOARD_WAIT, async {
                let fd = self.portal.selection_write(serial).await?;
                write_all(fd, text.as_bytes()).await
            })
            .await
            .unwrap_or_else(|_| Err(timed_out())),
            None => Err(anyhow!("No pushed text in type {mime_type}")),
        };
        self.portal
            .selection_write_done(serial, written.is_ok())
            .await?;
        written
    }

    /// The desktop's clipboard text: empty when it holds no text.
    pub(crate) async fn read(&self) -> Result<String> {
        tokio::time::timeout(CLIPBOARD_WAIT, self.read_now())
            .await
            .unwrap_or_else(|_| Err(timed_out()))
    }

    async fn read_now(&self) -> Result<String> {
        let (selection, offered) = {
            let holder = self.holder();
            (holder.selection.clone(), holder.offered.clone())
        };
        let candidates = match selection {
            Selection::Ours => return Ok(offered.unwrap_or_default()),
            Selection::Unknown => WANTED.iter().map(|wanted| (*wanted).to_owned()).collect(),
            Selection::Other(offered) => text_types(&offered),
        };
        let mut failure = None;
        for mime_type in candidates {
            match self.portal.selection_read(&mime_type).await {
                Ok(fd) => {
                    let bytes = read_capped(fd, MAX_CLIPBOARD_BYTES).await?;
                    return Ok(String::from_utf8_lossy(&bytes).into_owned());
                }
                Err(error) => failure = Some(error),
            }
        }
        // Nothing that is text reads as empty (SPEC-DESKTOP 21.2).
        failure.map_or_else(|| Ok(String::new()), Err)
    }
}

/// The text types among `offered`, in [`WANTED`] order, spelt as the
/// owner spelt them (types compare without regard to case).
pub(crate) fn text_types(offered: &[String]) -> Vec<String> {
    WANTED
        .iter()
        .filter_map(|wanted| {
            offered
                .iter()
                .find(|offered| offered.eq_ignore_ascii_case(wanted))
                .cloned()
        })
        .collect()
}

fn non_blocking(fd: OwnedFd) -> Result<AsyncFd<std::fs::File>> {
    use std::os::fd::AsRawFd as _;
    let file = std::fs::File::from(fd);
    // SAFETY: fcntl on a descriptor this function owns.
    let flags = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETFL) };
    if flags < 0
        || unsafe { libc::fcntl(file.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0
    {
        return Err(std::io::Error::last_os_error().into());
    }
    // SAFETY: the AsyncFd owns the file, so its descriptor stays open and
    // the same until the AsyncFd is dropped.
    unsafe { AsyncFd::register(file) }.map_err(|error| error.into_parts().1.into())
}

/// Everything until the writer closes `fd`; more than `cap` bytes fails.
pub(crate) async fn read_capped(fd: OwnedFd, cap: usize) -> Result<Vec<u8>> {
    let fd = non_blocking(fd)?;
    let mut bytes = Vec::new();
    let mut chunk = vec![0; 64 * 1024];
    loop {
        let mut ready = fd.readable().await?;
        match ready.try_io(|file| file.get_ref().read(&mut chunk)) {
            Ok(Ok(0)) => return Ok(bytes),
            Ok(Ok(count)) => {
                if bytes.len() + count > cap {
                    bail!(bmuster_desktop::clipboard::too_large().0);
                }
                bytes.extend_from_slice(&chunk[..count]);
            }
            Ok(Err(error)) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Ok(Err(error)) => return Err(error.into()),
            Err(_would_block) => {}
        }
    }
}

/// Writes all of `bytes` to `fd`, then closes it.
pub(crate) async fn write_all(fd: OwnedFd, mut bytes: &[u8]) -> Result<()> {
    let fd = non_blocking(fd)?;
    while !bytes.is_empty() {
        let mut ready = fd.writable().await?;
        match ready.try_io(|file| file.get_ref().write(bytes)) {
            Ok(Ok(0)) => bail!("The pasting program stopped reading"),
            Ok(Ok(count)) => bytes = &bytes[count..],
            Ok(Err(error)) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Ok(Err(error)) => return Err(error.into()),
            Err(_would_block) => {}
        }
    }
    Ok(())
}

/// The desktop's Clipboard portal for the helper's RemoteDesktop session.
pub(crate) struct Live<'a> {
    pub clipboard: &'a Clipboard<'a>,
    pub session: &'a Session<'a, RemoteDesktop<'a>>,
}

/// Opens the Clipboard portal and asks for clipboard access on `session`,
/// which has not started yet (`RequestClipboard` must come before
/// `Start`). The error is the reason copy and paste will be unavailable.
pub(crate) async fn request(
    session: &Session<'_, RemoteDesktop<'_>>,
) -> std::result::Result<Clipboard<'static>, String> {
    let clipboard = Clipboard::new().await.map_err(|error| {
        format!("This desktop's portal has no clipboard support, so copy and paste is unavailable ({error}).")
    })?;
    clipboard
        .request(session)
        .await
        .map_err(|error| portal_error(error).to_string())?;
    Ok(clipboard)
}

/// The helper's clipboard, as the portal allowed it before Start.
pub(crate) enum Opened {
    Ready {
        portal: Clipboard<'static>,
        signals: std::pin::Pin<Box<dyn futures_util::Stream<Item = Signal>>>,
    },
    /// Why copy and paste is unavailable, for the person to read.
    Unavailable(String),
}

/// Asks for clipboard access on the unstarted `session` and listens for
/// its signals. A desktop without the Clipboard portal, or one that
/// refuses, leaves the session without copy and paste, never without
/// a screen.
pub(crate) async fn open(session: &Session<'_, RemoteDesktop<'_>>) -> Opened {
    let portal = match request(session).await {
        Ok(portal) => portal,
        Err(reason) => {
            log::warn!("Wayland clipboard: {reason}");
            return Opened::Unavailable(reason);
        }
    };
    match signals(&portal, session).await {
        Ok(signals) => Opened::Ready {
            portal,
            signals: Box::pin(signals),
        },
        Err(error) => {
            let reason =
                format!("The desktop portal's clipboard signals are unavailable: {error:#}");
            log::warn!("Wayland clipboard: {reason}");
            Opened::Unavailable(reason)
        }
    }
}

/// The portal's reason, with access refusals in plain words.
fn portal_error(error: ashpd::Error) -> anyhow::Error {
    use ashpd::{Error, PortalError};
    let denied = match &error {
        Error::Portal(PortalError::NotAllowed(_)) => true,
        Error::Portal(PortalError::ZBus(zbus::Error::MethodError(name, _, _)))
        | Error::Zbus(zbus::Error::MethodError(name, _, _)) => {
            name.as_str().ends_with(".AccessDenied") || name.as_str().ends_with(".NotAllowed")
        }
        _ => false,
    };
    if denied {
        anyhow!(NOT_ALLOWED)
    } else {
        anyhow!("The desktop portal's clipboard failed: {error}")
    }
}

impl Portal for Live<'_> {
    async fn set_selection(&self, mime_types: &[&str]) -> Result<()> {
        self.clipboard
            .set_selection(self.session, mime_types)
            .await
            .map_err(portal_error)
    }
    async fn selection_write(&self, serial: u32) -> Result<OwnedFd> {
        Ok(self
            .clipboard
            .selection_write(self.session, serial)
            .await
            .map_err(portal_error)?
            .into())
    }
    async fn selection_write_done(&self, serial: u32, success: bool) -> Result<()> {
        self.clipboard
            .selection_write_done(self.session, serial, success)
            .await
            .map_err(portal_error)
    }
    async fn selection_read(&self, mime_type: &str) -> Result<OwnedFd> {
        Ok(self
            .clipboard
            .selection_read(self.session, mime_type)
            .await
            .map_err(portal_error)?
            .into())
    }
}

/// A clipboard signal for the helper's session.
pub(crate) enum Signal {
    /// A program pastes the pushed text in `mime_type`.
    Transfer { mime_type: String, serial: u32 },
    /// The clipboard changed hands.
    OwnerChanged {
        session_is_owner: Option<bool>,
        mime_types: Vec<String>,
    },
}

/// The portal's `SelectionTransfer` and `SelectionOwnerChanged` signals
/// for `session`. ashpd's own streams look up a session object for every
/// signal and drop the signal when that fails, which would leave a paste
/// hanging, so these parse the signals here.
pub(crate) async fn signals(
    clipboard: &Clipboard<'_>,
    session: &Session<'_, RemoteDesktop<'_>>,
) -> Result<impl futures_util::Stream<Item = Signal> + use<>> {
    use futures_util::StreamExt as _;
    use zbus::zvariant::OwnedObjectPath;
    let ours = session_path(session)?;
    let transfers = clipboard.receive_signal("SelectionTransfer").await?;
    let changes = clipboard.receive_signal("SelectionOwnerChanged").await?;
    let transfer_path = ours.clone();
    let transfers = transfers.filter_map(move |message| {
        let parsed = message
            .body()
            .deserialize::<(OwnedObjectPath, String, u32)>()
            .ok()
            .filter(|(path, _, _)| *path == transfer_path)
            .map(|(_, mime_type, serial)| Signal::Transfer { mime_type, serial });
        std::future::ready(parsed)
    });
    let changes = changes.filter_map(move |message| {
        let parsed = message
            .body()
            .deserialize::<(
                OwnedObjectPath,
                ashpd::desktop::clipboard::SelectionOwnerChanged,
            )>()
            .ok()
            .filter(|(path, _)| *path == ours)
            .map(|(_, change)| Signal::OwnerChanged {
                session_is_owner: change.session_is_owner(),
                mime_types: change.mime_types(),
            });
        std::future::ready(parsed)
    });
    Ok(futures_util::stream::select(transfers, changes))
}

/// The object path of `session`, which ashpd keeps to itself but writes
/// as the session's D-Bus value.
fn session_path(
    session: &Session<'_, RemoteDesktop<'_>>,
) -> Result<zbus::zvariant::OwnedObjectPath> {
    use zbus::zvariant::{serialized::Context, to_bytes, OwnedObjectPath, LE};
    let bytes = to_bytes(Context::new_dbus(LE, 0), session)?;
    let (path, _): (OwnedObjectPath, _) = bytes.deserialize()?;
    Ok(path)
}

#[cfg(test)]
mod tests;
