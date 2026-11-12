//! Root-side capture/input adapters for the private user-session bridge.
use super::{
    clipboard::{Replies, Reply, AGENT_WAIT},
    png_stream,
    wire::{self, Command, Event, Packet},
};
use crate::exec::connect::{self, ConnectSocket, Folder, Peer};
use crate::exec::unit::Manager;
use anyhow::{bail, Context as _, Result};
use bmuster_desktop::capture::{
    CaptureError, CaptureResult, Capturer, CursorImage, CursorState, Damage, DesktopState,
    DisplayInfo, Frame, View,
};
use bmuster_desktop::input::{
    keymap::KeyPosition,
    typing::{self, Typing},
    Axis, Button, InputBackend, InputError, InputResult,
};
use std::ffi::OsString;
use std::io::BufReader;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::{
    mpsc::{self, SyncSender},
    Arc, Mutex,
};

#[derive(Default)]
pub struct State {
    pub frame: Option<Frame>,
    pub ready: bool,
    pub geometry: Option<(i32, i32, i32, i32)>,
    pub error: Option<String>,
}
pub struct Bridge {
    pub state: Arc<Mutex<State>>,
    commands: SyncSender<Command>,
    /// Clipboard calls waiting for the helper (SPEC-DESKTOP 21.9).
    clipboard: Arc<Replies>,
    /// Another program took the clipboard since the last look (21.11).
    clipboard_changed: Arc<std::sync::atomic::AtomicBool>,
    child: Mutex<Child>,
    unit: String,
    _reservation: Reservation,
    /// The helper's connection; closing it ends the helper.
    stream: UnixStream,
}

static ACTIVE: std::sync::LazyLock<std::sync::Mutex<std::collections::HashSet<(u32, bool)>>> =
    std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::HashSet::new()));

struct Reservation(u32, bool);
impl Reservation {
    fn acquire(uid: u32, control: bool) -> Result<Self> {
        let mut active = ACTIVE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if !active.insert((uid, control)) {
            bail!(
                "A Wayland {} session is already active for this user",
                if control { "control" } else { "watch" }
            );
        }
        Ok(Self(uid, control))
    }
}
impl Drop for Reservation {
    fn drop(&mut self) {
        ACTIVE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&(self.0, self.1));
    }
}
impl Drop for Bridge {
    fn drop(&mut self) {
        let _ = self.commands.try_send(Command::Stop);
        let _ = self.stream.shutdown(std::net::Shutdown::Both);
        let _ = std::process::Command::new("systemctl")
            .args(["stop", "--no-block", &self.unit])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        if let Ok(child) = self.child.get_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

pub fn token_path(dir: &Path, uid: u32, control: bool) -> PathBuf {
    dir.join(format!(
        "wayland-{uid}-{}.json",
        if control { "control" } else { "watch" }
    ))
}

/// `systemd-run`'s arguments for the helper unit `unit`, run as `uid`:
/// `program` with the hidden `subcommand` (`wayland-helper`, or
/// `clipboard-helper` for a KMS screen's clipboard, SPEC-DESKTOP 21.10).
/// Its standard streams are systemd's own (`/dev/null`, the journal): the
/// helper connects back to `socket`, its one argument (SPEC-SESSION-UNITS,
/// Version 2).
pub fn unit_arguments(
    unit: &str,
    uid: u32,
    program: &Path,
    subcommand: &str,
    socket: &Path,
) -> Vec<OsString> {
    let mut args: Vec<OsString> = [
        "--quiet".to_string(),
        "--wait".to_string(),
        "--collect".to_string(),
        "--service-type=exec".to_string(),
        format!("--unit={unit}"),
        format!("--uid={uid}"),
        "--property=KillMode=control-group".to_string(),
        "--property=TimeoutStopSec=3".to_string(),
        "--property=NoNewPrivileges=yes".to_string(),
        "--property=UMask=0077".to_string(),
        "--property=StandardInput=null".to_string(),
        "--property=StandardOutput=journal".to_string(),
        "--property=StandardError=journal".to_string(),
        format!("--setenv=XDG_RUNTIME_DIR=/run/user/{uid}"),
        format!("--setenv=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/{uid}/bus"),
        "--".to_string(),
    ]
    .map(OsString::from)
    .to_vec();
    args.push(program.into());
    args.push(subcommand.into());
    args.push(socket.into());
    args
}

pub fn start(uid: u32, control: bool, dir: &Path) -> Result<Arc<Bridge>> {
    if uid == 0 {
        bail!("A Wayland helper cannot run as root");
    }
    let reservation = Reservation::acquire(uid, control)?;
    let program = super::helper_program()?;
    let unit = format!(
        "bmuster-wayland-{}-{}.service",
        std::process::id(),
        super::next_id()
    );
    // The socket is the user's: the helper runs as them.
    let socket = ConnectSocket::create(&Folder::system(), uid)?;
    let mut command = std::process::Command::new("systemd-run");
    command.args(unit_arguments(
        &unit,
        uid,
        &program,
        "wayland-helper",
        socket.path(),
    ));
    // systemd-run's own errors are shipped (SPEC-AGENT-LOGS 1); the
    // helper's and gst-launch's go to the journal.
    let connected = connect::start(
        socket,
        &Peer::new(uid, &unit, Manager::System),
        command,
        "wayland-helper",
        &std::sync::atomic::AtomicBool::new(false),
    )
    .context("Could not launch the Wayland user helper")?;
    let stream = connected.stream;
    let mut child = ChildGuard(Some(connected.systemd_run));
    let result = (|| -> Result<Arc<Bridge>> {
        let token_file = token_path(dir, uid, control);
        let restore_token = match std::fs::read(&token_file) {
            Ok(bytes) => Some(
                serde_json::from_slice::<String>(&bytes)
                    .context("Cannot read saved Wayland permission")?,
            ),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.into()),
        };
        let mut input = stream.try_clone()?;
        let mut output = BufReader::new(stream.try_clone()?);
        wire::json(
            &mut input,
            &Command::Configure {
                control,
                restore_token,
            },
        )?;
        let (send, commands) = mpsc::sync_channel(32);
        let state = Arc::new(Mutex::new(State::default()));
        let writing_state = Arc::clone(&state);
        std::thread::Builder::new()
            .name("wayland commands".into())
            .spawn(move || {
                while let Ok(command) = commands.recv() {
                    if let Err(error) = wire::json(&mut input, &command) {
                        writing_state
                            .lock()
                            .unwrap_or_else(|p| p.into_inner())
                            .error = Some(format!("Wayland input stopped: {error:#}"));
                        break;
                    }
                }
            })?;
        let reading_state = Arc::clone(&state);
        let clipboard = Arc::new(Replies::default());
        let replies = Arc::clone(&clipboard);
        let clipboard_changed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let changed = Arc::clone(&clipboard_changed);
        std::thread::Builder::new()
            .name("wayland frames".into())
            .spawn(move || {
                let result = (|| -> Result<()> {
                    loop {
                        match wire::read(&mut output)? {
                            Packet::Json(bytes) if bytes.len() <= wire::MAX_JSON => {
                                match serde_json::from_slice::<Event>(&bytes)? {
                                    Event::Token { token: Some(token) } => {
                                        crate::identity::write_private(
                                            &token_file,
                                            &serde_json::to_vec(&token)?,
                                        )?
                                    }
                                    Event::Token { token: None } => {
                                        match std::fs::remove_file(&token_file) {
                                            Ok(()) => {}
                                            Err(error)
                                                if error.kind() == std::io::ErrorKind::NotFound => {
                                            }
                                            Err(error) => return Err(error.into()),
                                        }
                                    }
                                    Event::Ready {
                                        x,
                                        y,
                                        width,
                                        height,
                                    } => {
                                        let mut state =
                                            reading_state.lock().unwrap_or_else(|p| p.into_inner());
                                        state.geometry = Some((x, y, width, height));
                                        state.ready = true;
                                    }
                                    Event::Failed { message } => bail!("{message}"),
                                    Event::ClipboardBackend { .. } => {
                                        bail!("The portal helper sent a clipboard helper event")
                                    }
                                    Event::ClipboardChanged => {
                                        changed.store(true, std::sync::atomic::Ordering::Relaxed)
                                    }
                                    Event::ClipboardSet { id } => replies.deliver(id, Reply::Set),
                                    Event::ClipboardText { id, text } => {
                                        replies.deliver(id, Reply::Text(text))
                                    }
                                    Event::ClipboardFailed { id, message } => {
                                        replies.deliver(id, Reply::Failed(message))
                                    }
                                }
                            }
                            Packet::Png(bytes) => {
                                let frame = png_stream::decode(&bytes)?;
                                reading_state
                                    .lock()
                                    .unwrap_or_else(|p| p.into_inner())
                                    .frame = Some(frame);
                            }
                            _ => bail!("Invalid helper event"),
                        }
                    }
                })();
                replies.close();
                if let Err(error) = result {
                    reading_state
                        .lock()
                        .unwrap_or_else(|p| p.into_inner())
                        .error = Some(format!("{error:#}"));
                }
            })?;
        Ok(Arc::new(Bridge {
            state,
            commands: send,
            clipboard,
            clipboard_changed,
            child: Mutex::new(child.0.take().context("Helper process absent")?),
            stream: stream.try_clone()?,
            unit: unit.clone(),
            _reservation: reservation,
        }))
    })();
    result
}

struct ChildGuard(Option<Child>);
impl Drop for ChildGuard {
    fn drop(&mut self) {
        if let Some(child) = &mut self.0 {
            // A helper that ended by itself says how (SPEC-DIAGNOSTICS 2).
            if let Ok(Some(status)) = child.try_wait() {
                if !status.success() {
                    log::warn!("The Wayland user helper exited with {status}");
                    crate::timeline::step("helper-exited", &format!("wayland helper: {status}"));
                }
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Bridge {
    fn send(&self, command: Command) -> InputResult<()> {
        self.commands
            .try_send(command)
            .map_err(|_| InputError("The Wayland input queue is busy or closed".into()))
    }

    /// Sends the clipboard command `command` builds and waits for the
    /// helper's answer. It holds the session thread, as an X11 read does,
    /// for at most [`AGENT_WAIT`].
    fn ask_clipboard(&self, command: impl FnOnce(u64) -> Command) -> InputResult<Reply> {
        self.clipboard.ask(AGENT_WAIT, |id| self.send(command(id)))
    }
}

pub struct Screen {
    bridge: Arc<Bridge>,
    frame: Frame,
    displays: Vec<DisplayInfo>,
    changed: bool,
    dirty: bool,
}
impl Screen {
    pub fn new(bridge: Arc<Bridge>) -> Result<Self> {
        let frame = bridge
            .state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .frame
            .clone()
            .context("Waiting for the first Wayland frame")?;
        let displays = vec![display(&frame)];
        Ok(Self {
            bridge,
            frame,
            displays,
            changed: true,
            dirty: true,
        })
    }
    fn refresh(&mut self) -> CaptureResult<Damage> {
        let state = self.bridge.state.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(error) = &state.error {
            return Err(CaptureError::new(error));
        }
        if let Some(frame) = state.frame.as_ref().filter(|frame| *frame != &self.frame) {
            self.changed |= (frame.width, frame.height) != (self.frame.width, self.frame.height);
            self.frame = frame.clone();
            self.dirty = true;
            self.displays = vec![display(&self.frame)];
            Ok(Damage::Unknown)
        } else {
            Ok(Damage::None)
        }
    }
}
fn display(frame: &Frame) -> DisplayInfo {
    DisplayInfo {
        id: "wayland-monitor".into(),
        name: "Shared Wayland monitor".into(),
        x: 0,
        y: 0,
        width: frame.width,
        height: frame.height,
        scale: 1.0,
        primary: true,
    }
}
impl Capturer for Screen {
    fn displays(&self) -> &[DisplayInfo] {
        &self.displays
    }
    fn view(&self) -> View {
        View::Display(0)
    }
    /// The portal shares the one monitor the person picked.
    fn can_show_all(&self) -> bool {
        false
    }
    fn select(&mut self, view: View) -> CaptureResult<()> {
        if view != View::Display(0) {
            return Err(CaptureError::new(
                "Choose the monitor in the desktop's sharing dialog",
            ));
        }
        Ok(())
    }
    fn poll_layout(&mut self) -> CaptureResult<bool> {
        self.refresh()?;
        Ok(std::mem::take(&mut self.changed))
    }
    fn capture(&mut self, full: bool) -> CaptureResult<Damage> {
        self.refresh()?;
        Ok(if std::mem::take(&mut self.dirty) || full {
            Damage::Unknown
        } else {
            Damage::None
        })
    }
    fn frame(&self) -> &Frame {
        &self.frame
    }
    fn cursor(&mut self) -> CaptureResult<CursorState> {
        Ok(CursorState {
            id: 0,
            x: 0,
            y: 0,
            visible: false,
        })
    }
    fn cursor_image(&mut self, _: u32) -> CaptureResult<Option<CursorImage>> {
        Ok(None)
    }
    fn state(&self) -> DesktopState {
        DesktopState::Desktop { user: None }
    }

    fn backend(&self) -> &'static str {
        "portal"
    }
}

pub struct Input {
    pub bridge: Arc<Bridge>,
    pub physical: (i32, i32),
    pub typing: Typing,
}
impl InputBackend for Input {
    fn move_pointer(&mut self, x: i32, y: i32) -> InputResult<()> {
        let geometry = self
            .bridge
            .state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .geometry
            .ok_or_else(|| InputError("The Wayland monitor geometry is unavailable".into()))?;
        if self.physical.0 <= 0 || self.physical.1 <= 0 {
            return Err(InputError(
                "The Wayland frame has invalid dimensions".into(),
            ));
        }
        let (mapped_x, mapped_y) = map_pointer(x, y, self.physical, geometry);
        self.bridge.send(Command::Pointer {
            x: mapped_x,
            y: mapped_y,
        })
    }
    fn button(&mut self, button: Button, down: bool) -> InputResult<()> {
        let code = match button {
            Button::Left => 272,
            Button::Right => 273,
            Button::Middle => 274,
            Button::Back => 275,
            Button::Forward => 276,
        };
        self.bridge.send(Command::Button { code, down })
    }
    fn scroll(&mut self, axis: Axis, units: i32) -> InputResult<()> {
        let amount = f64::from(units) / 120.0 * 15.0;
        let (dx, dy) = match axis {
            Axis::Horizontal => (amount, 0.0),
            Axis::Vertical => (0.0, amount),
        };
        self.bridge.send(Command::Scroll { dx, dy })
    }
    fn key(&mut self, key: &KeyPosition, down: bool) -> InputResult<()> {
        self.bridge.send(Command::Key {
            code: i32::from(key.evdev),
            down,
        })
    }
    fn alt_gr(&mut self, down: bool) -> InputResult<()> {
        self.bridge.send(Command::Key { code: 100, down })
    }
    fn type_char(&mut self, character: char) -> InputResult<()> {
        let bridge = &self.bridge;
        match self.typing.strokes(character) {
            Some(strokes) => typing::play(
                &strokes,
                |code, down| bridge.send(key_command(code, down)),
                |pause| self.typing.pause(pause),
            ),
            None => bridge.send(Command::Character { character }),
        }
    }
    fn secure_attention(&mut self) -> InputResult<bool> {
        Ok(false)
    }
    fn flush(&mut self) -> InputResult<()> {
        Ok(())
    }

    /// Through the helper's Clipboard portal (SPEC-DESKTOP 21.9).
    fn set_clipboard(&mut self, text: &str) -> InputResult<()> {
        match self.bridge.ask_clipboard(|id| Command::ClipboardSet {
            id,
            text: text.to_owned(),
        })? {
            Reply::Set => Ok(()),
            Reply::Failed(message) => Err(InputError(message)),
            Reply::Text(_) => Err(unexpected_reply()),
        }
    }

    fn clipboard(&mut self) -> InputResult<String> {
        match self
            .bridge
            .ask_clipboard(|id| Command::ClipboardGet { id })?
        {
            Reply::Text(text) => Ok(text),
            Reply::Failed(message) => Err(InputError(message)),
            Reply::Set => Err(unexpected_reply()),
        }
    }

    /// Whether another program took the clipboard since the last look,
    /// as the portal told the helper (SPEC-DESKTOP 21.11).
    fn clipboard_changed(&mut self) -> InputResult<bool> {
        Ok(self
            .bridge
            .clipboard_changed
            .swap(false, std::sync::atomic::Ordering::Relaxed))
    }
}

fn unexpected_reply() -> InputError {
    InputError("The Wayland helper answered the clipboard call wrongly".into())
}

/// A typed character's key on the portal: `NotifyKeyboardKeycode` takes
/// the evdev code, as [`Input::key`] sends it. A keysym alone lost its case
/// on KDE (KWin pressed the key the keysym is on, without Shift), so
/// characters on the US layout go as their key with Shift
/// ([`typing::strokes`]) and only the rest as a keysym
/// (SPEC-CONSOLE-CAPTURE version 3).
fn key_command(code: u16, down: bool) -> Command {
    Command::Key {
        code: i32::from(code),
        down,
    }
}

/// What the portal is sent for `character` with Caps Lock as given: key
/// commands and pauses, or one keysym.
#[cfg(test)]
fn portal_typing(character: char, caps_lock: bool) -> Vec<Result<Command, std::time::Duration>> {
    match typing::strokes(character, caps_lock) {
        Some(strokes) => strokes
            .into_iter()
            .map(|stroke| match stroke {
                typing::Stroke::Key { code, down } => Ok(key_command(code, down)),
                typing::Stroke::Pause(length) => Err(length),
            })
            .collect(),
        None => vec![Ok(Command::Character { character })],
    }
}

fn map_pointer(x: i32, y: i32, physical: (i32, i32), geometry: (i32, i32, i32, i32)) -> (i32, i32) {
    let local_x = x.clamp(0, physical.0 - 1);
    let local_y = y.clamp(0, physical.1 - 1);
    (
        geometry.0 + (i64::from(local_x) * i64::from(geometry.2) / i64::from(physical.0)) as i32,
        geometry.1 + (i64::from(local_y) * i64::from(geometry.3) / i64::from(physical.1)) as i32,
    )
}

#[cfg(test)]
mod tests {
    use super::map_pointer;

    /// SPEC-CONSOLE-CAPTURE K6: the portal types US characters as keys with
    /// Shift (Caps Lock turning letters round) and the rest as a keysym.
    #[test]
    fn portal_types_capitals_as_keys_with_shift() {
        use super::{portal_typing, Command};
        use bmuster_desktop::input::typing::{CHARACTER_GAP, SHIFT_SETTLE};
        let keys = |character, caps| {
            portal_typing(character, caps)
                .into_iter()
                .map(|step| match step {
                    Ok(Command::Key { code, down }) => {
                        format!("{code}{}", if down { '+' } else { '-' })
                    }
                    Ok(Command::Character { character }) => format!("sym {character}"),
                    Ok(other) => panic!("unexpected {other:?}"),
                    Err(pause) if pause == SHIFT_SETTLE => "settle".into(),
                    Err(pause) if pause == CHARACTER_GAP => "gap".into(),
                    Err(pause) => panic!("unexpected pause {pause:?}"),
                })
                .collect::<Vec<_>>()
                .join(" ")
        };
        assert_eq!(keys('A', false), "42+ settle 30+ 30- settle 42- gap");
        assert_eq!(keys('a', false), "30+ 30- gap");
        assert_eq!(keys('!', false), "42+ settle 2+ 2- settle 42- gap");
        assert_eq!(keys('A', true), "30+ 30- gap");
        assert_eq!(keys('a', true), "42+ settle 30+ 30- settle 42- gap");
        assert_eq!(keys('!', true), "42+ settle 2+ 2- settle 42- gap");
        assert_eq!(keys('é', false), "sym é");
        assert_eq!(keys('€', true), "sym €");
    }

    #[test]
    fn pointer_maps_pixels_to_portal_coordinates_and_clamps_edges() {
        let physical = (3840, 2160);
        let geometry = (1920, 0, 1920, 1080);
        assert_eq!(map_pointer(0, 0, physical, geometry), (1920, 0));
        assert_eq!(map_pointer(1920, 1080, physical, geometry), (2880, 540));
        assert_eq!(map_pointer(3840, 2160, physical, geometry), (3839, 1079));
        assert_eq!(map_pointer(-1, -1, physical, geometry), (1920, 0));
    }
}
