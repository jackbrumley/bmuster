//! Copy and paste on KMS screens (SPEC-DESKTOP 21.10).
//!
//! KMS reads the screen below the display server and uinput is a virtual
//! keyboard, so neither reaches the clipboard. When the screen shows a
//! person's own unlocked session, the root agent starts a small helper
//! **as that person** (a transient system unit with their uid, like the
//! portal helper) and sends it the clipboard calls over the private
//! connect-back socket. The helper ([`helper`]) tries the standard routes
//! in turn: Wayland data-control, then the X11 `CLIPBOARD` selection of the
//! session's XWayland (or X server).
//!
//! Two halves here:
//!
//! - [`KmsClipboard`], one per control session's injector: before every
//!   call it reads the logind session on the screen and refuses at the
//!   sign-in screen and while the session is locked
//!   ([`bmuster_desktop::clipboard::route`]); otherwise it starts the
//!   helper on first use and keeps it while the injector lives, so a
//!   pushed text is served until another program copies or the control
//!   session ends.
//! - [`UserHelper`], the agent's end of one helper's socket: calls by id
//!   through [`Replies`], as the portal path does.
//!
//! Neither half ever logs the text; the agent log names the route that
//! served each call and its byte count.

mod data_control;
pub mod helper;
mod routes;
mod xwayland;

use super::clipboard::{Replies, Reply, AGENT_WAIT};
use super::wire::{self, Command, Event, Packet};
use crate::exec::connect::{self, ConnectSocket, Folder, Peer};
use crate::exec::unit::Manager;
use anyhow::{bail, Context as _, Result};
use bmuster_desktop::clipboard::{route, Route, ScreenClipboard};
use bmuster_desktop::input::{InputError, InputResult};
use std::collections::HashMap;
use std::io::BufReader;
use std::os::unix::net::UnixStream;
use std::process::{Child, Stdio};
use std::sync::mpsc::{self, SyncSender};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::Duration;

/// Reads the logind properties of a session.
type Look = Box<dyn FnMut(&str) -> Result<HashMap<String, String>, String> + Send>;
/// Starts the helper for a uid.
type Start = Box<dyn FnMut(u32) -> Result<UserHelper> + Send>;

/// The clipboard of the session on a KMS screen, for one control
/// session's injector.
pub(crate) struct KmsClipboard {
    /// The logind session the screen showed when the injector was made
    /// (`none` for no session).
    session: String,
    look: Look,
    start: Start,
    helper: Option<UserHelper>,
}

impl KmsClipboard {
    /// The real thing: logind through `loginctl`, the helper through
    /// `systemd-run`.
    pub(crate) fn system(session: &str) -> Self {
        Self::with(
            session,
            Box::new(bmuster_desktop::capture::x11_follow::session_properties),
            Box::new(UserHelper::start),
        )
    }

    fn with(session: &str, look: Look, start: Start) -> Self {
        Self {
            session: session.to_string(),
            look,
            start,
            helper: None,
        }
    }

    /// The helper for the person on the screen now, started if needed; a
    /// refusal at the sign-in screen, while locked or on a screen with no
    /// person's session.
    fn helper(&mut self) -> InputResult<&UserHelper> {
        let properties = if self.session == "none" {
            HashMap::new()
        } else {
            (self.look)(&self.session).map_err(|error| {
                InputError(format!("Cannot read the session on the screen: {error}"))
            })?
        };
        let uid = match route(&properties) {
            Route::User { uid } => uid,
            Route::Refused(reason) => return Err(InputError(reason)),
        };
        if self
            .helper
            .as_ref()
            .is_some_and(|helper| helper.uid != uid || helper.replies.is_closed())
        {
            self.helper = None;
        }
        if self.helper.is_none() {
            let started = (self.start)(uid).map_err(|error| {
                InputError(format!(
                    "Could not start the clipboard helper in the person's session: {error:#}"
                ))
            })?;
            log::info!("Started the clipboard helper for uid {uid}");
            self.helper = Some(started);
        }
        self.helper
            .as_ref()
            .ok_or_else(|| InputError("The clipboard helper did not start".into()))
    }
}

impl ScreenClipboard for KmsClipboard {
    fn set(&mut self, text: &str) -> InputResult<()> {
        let helper = self.helper()?;
        match helper.ask(|id| Command::ClipboardSet {
            id,
            text: text.to_owned(),
        })? {
            Reply::Set => {
                helper.served("push to", text.len());
                Ok(())
            }
            Reply::Failed(message) => Err(InputError(message)),
            Reply::Text(_) => Err(unexpected_reply()),
        }
    }

    fn get(&mut self) -> InputResult<String> {
        let helper = self.helper()?;
        match helper.ask(|id| Command::ClipboardGet { id })? {
            Reply::Text(text) => {
                helper.served("pull from", text.len());
                Ok(text)
            }
            Reply::Failed(message) => Err(InputError(message)),
            Reply::Set => Err(unexpected_reply()),
        }
    }
}

fn unexpected_reply() -> InputError {
    InputError("The clipboard helper answered the call wrongly".into())
}

/// The agent's end of one clipboard helper. Dropping it closes the socket
/// (the helper ends) and stops its unit.
pub(crate) struct UserHelper {
    uid: u32,
    commands: SyncSender<Command>,
    replies: Arc<Replies>,
    /// The route the helper last said it served through.
    backend: Arc<Mutex<String>>,
    stream: UnixStream,
    wait: Duration,
    /// The unit and `systemd-run`, stopped after the socket closes.
    _process: Box<dyn Send>,
}

impl Drop for UserHelper {
    fn drop(&mut self) {
        let _ = self.commands.try_send(Command::Stop);
        let _ = self.stream.shutdown(std::net::Shutdown::Both);
    }
}

/// A started helper unit: stopped, and `systemd-run` reaped, when dropped.
struct Unit {
    name: String,
    systemd_run: Child,
}

impl Drop for Unit {
    fn drop(&mut self) {
        let _ = std::process::Command::new("systemctl")
            .args(["stop", "--no-block", &self.name])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        let _ = self.systemd_run.kill();
        let _ = self.systemd_run.wait();
    }
}

impl UserHelper {
    /// Starts `bmuster-agent clipboard-helper` as `uid` in a transient
    /// system unit, with their runtime folder and session bus, and waits
    /// for it to connect back.
    fn start(uid: u32) -> Result<UserHelper> {
        if uid == 0 {
            bail!("The clipboard helper cannot run as root");
        }
        let program = super::helper_program()?;
        let unit = format!(
            "bmuster-wayland-clipboard-{}-{}.service",
            std::process::id(),
            super::next_id()
        );
        // The socket is the person's: the helper runs as them.
        let socket = ConnectSocket::create(&Folder::system(), uid)?;
        let mut command = std::process::Command::new("systemd-run");
        command.args(super::capture::unit_arguments(
            &unit,
            uid,
            &program,
            "clipboard-helper",
            socket.path(),
        ));
        let connected = connect::start(
            socket,
            &Peer::new(uid, &unit, Manager::System),
            command,
            "clipboard-helper",
            &std::sync::atomic::AtomicBool::new(false),
        )
        .context("Could not launch the clipboard helper")?;
        UserHelper::over(
            uid,
            connected.stream,
            AGENT_WAIT,
            Box::new(Unit {
                name: unit,
                systemd_run: connected.systemd_run,
            }),
        )
    }

    /// The agent's end of a helper connected on `stream`: one thread
    /// writes the commands, one reads the answers and hands each to the
    /// call with its id. Calls wait at most `wait`.
    fn over(
        uid: u32,
        stream: UnixStream,
        wait: Duration,
        process: Box<dyn Send>,
    ) -> Result<UserHelper> {
        let (commands, queued) = mpsc::sync_channel::<Command>(8);
        let mut input = stream.try_clone()?;
        std::thread::Builder::new()
            .name("clipboard commands".into())
            .spawn(move || {
                while let Ok(command) = queued.recv() {
                    if wire::json(&mut input, &command).is_err() {
                        break;
                    }
                }
            })?;
        let replies = Arc::new(Replies::default());
        let backend = Arc::new(Mutex::new(String::new()));
        let mut output = BufReader::new(stream.try_clone()?);
        let (reading, named) = (Arc::clone(&replies), Arc::clone(&backend));
        std::thread::Builder::new()
            .name("clipboard answers".into())
            .spawn(move || {
                if let Err(error) = read_answers(&mut output, &reading, &named) {
                    log::warn!("The clipboard helper for uid {uid} stopped: {error:#}");
                }
                reading.close();
            })?;
        Ok(UserHelper {
            uid,
            commands,
            replies,
            backend,
            stream,
            wait,
            _process: process,
        })
    }

    fn ask(&self, command: impl FnOnce(u64) -> Command) -> InputResult<Reply> {
        self.replies.ask(self.wait, |id| {
            self.commands
                .try_send(command(id))
                .map_err(|_| InputError("The clipboard helper is busy or has stopped".into()))
        })
    }

    /// One line for the agent log: the direction, the byte count and the
    /// route, never the text.
    fn served(&self, direction: &str, bytes: usize) {
        let backend = self
            .backend
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        log::info!(
            "Clipboard {direction} the session of uid {}: {bytes} bytes through {backend}",
            self.uid
        );
    }
}

/// The helper's events until its socket closes.
fn read_answers(
    output: &mut impl std::io::Read,
    replies: &Replies,
    backend: &Mutex<String>,
) -> Result<()> {
    loop {
        let bytes = match wire::read(&mut *output) {
            Ok(Packet::Json(bytes)) if bytes.len() <= wire::MAX_JSON => bytes,
            Ok(_) => bail!("Invalid clipboard helper packet"),
            // The socket closed: the helper or the agent ended it.
            Err(_) => return Ok(()),
        };
        match serde_json::from_slice::<Event>(&bytes)? {
            Event::ClipboardSet { id } => replies.deliver(id, Reply::Set),
            Event::ClipboardText { id, text } => replies.deliver(id, Reply::Text(text)),
            Event::ClipboardFailed { id, message } => replies.deliver(id, Reply::Failed(message)),
            Event::ClipboardBackend { backend: named } => {
                log::info!("The clipboard helper serves through {named}");
                *backend.lock().unwrap_or_else(PoisonError::into_inner) = named;
            }
            Event::Token { .. } | Event::Ready { .. } | Event::Failed { .. } => {
                bail!("The clipboard helper sent a portal event")
            }
        }
    }
}

#[cfg(test)]
mod tests;
