//! One viewer's desktop session: control messages in, frames out.
//!
//! [`DesktopSession`] is driven from outside: the caller feeds it the
//! browser's text frames ([`DesktopSession::handle_text`]) and calls
//! [`DesktopSession::tick`] when [`DesktopSession::next_tick`] is due. Both
//! return the messages to send. [`run`] is that loop over a channel, for the
//! session socket code to drive. Frames come from [`video`], cursor
//! messages from [`cursor`]. A session made with
//! [`DesktopSession::following`] follows the screen at the machine
//! ([`following`]).

mod clipboard;
mod cursor;
mod following;
mod video;
mod wake;

use crate::capture::{shown_rect, view_id, Capturer, Rect, View, ALL_DISPLAYS};
use crate::control::{
    self, AgentMessage, ClientMessage, Codec, EndReason, ErrorCode, Mode, Parsed, Scale, Viewport,
};
use crate::input::{InputBackend, InputController, InputResult};
use crate::pacing::{Pacer, TickDecision};
use cursor::CursorTracker;
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};
pub use video::Figures;
use video::Video;

/// Desktop sessions allowed at once on one machine (R15).
pub const MAX_SESSIONS: usize = 4;
/// Bad messages after which the session ends (SPEC-DESKTOP 7).
pub const MAX_BAD_MESSAGES: u32 = 20;
/// Default frame rate for tiles (SPEC-DESKTOP 4.3).
pub const DEFAULT_TILE_FPS: u32 = 15;

static OPEN_SESSIONS: AtomicUsize = AtomicUsize::new(0);

/// A place among the [`MAX_SESSIONS`]; freed when dropped.
#[derive(Debug)]
pub struct SessionSlot(());

impl SessionSlot {
    /// Takes a place, or `None` when the machine already has
    /// [`MAX_SESSIONS`] desktop sessions (reply `too-many-sessions`).
    pub fn try_acquire() -> Option<SessionSlot> {
        OPEN_SESSIONS
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |open| {
                (open < MAX_SESSIONS).then_some(open + 1)
            })
            .ok()
            .map(|_| SessionSlot(()))
    }
}

impl Drop for SessionSlot {
    fn drop(&mut self) {
        OPEN_SESSIONS.fetch_sub(1, Ordering::AcqRel);
    }
}

/// A message for the browser.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outgoing {
    /// A frame or cursor message (SPEC-DESKTOP 4).
    Binary(Vec<u8>),
    /// A JSON control message (SPEC-DESKTOP 5.2).
    Text(String),
}

/// What [`run`] receives from the session socket.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Incoming {
    Text(String),
    /// No binary messages flow browser to agent; ignored.
    Binary(Vec<u8>),
    /// End the session for a reason from outside (Disconnect at the
    /// machine, permission removed, no browser for 60 s).
    End(EndReason),
}

pub struct DesktopSession {
    mode: Mode,
    capturer: Box<dyn Capturer>,
    /// Only built for a control session (SPEC-DESKTOP 7).
    input: Option<InputController>,
    video: Video,
    cursor: CursorTracker,
    pacer: Pacer,
    started: Instant,
    greeted: bool,
    bad_messages: u32,
    told_not_allowed: bool,
    logged_types: HashSet<String>,
    viewport: Option<Viewport>,
    scale: Scale,
    ended: Option<EndReason>,
    /// Set when the session follows the screen instead of holding one.
    follow: Option<following::Follow>,
    /// The viewer chose all screens: a screen the session follows to
    /// opens that way too, when it can.
    wants_all: bool,
    /// Clipboard sharing (SPEC-DESKTOP 21.11).
    sharing: clipboard::Sharing,
}

impl DesktopSession {
    /// A session over `capturer`. `make_input` is called only for a control
    /// session, so a watch-only session never has an injector at all.
    pub fn new(
        mode: Mode,
        capturer: Box<dyn Capturer>,
        make_input: impl FnOnce() -> InputResult<Box<dyn InputBackend>>,
        now: Instant,
    ) -> InputResult<Self> {
        let input = match mode {
            Mode::Control => Some(InputController::new(make_input()?)),
            Mode::Watch => None,
        };
        Ok(DesktopSession::with(mode, capturer, input, now))
    }

    fn with(
        mode: Mode,
        capturer: Box<dyn Capturer>,
        input: Option<InputController>,
        now: Instant,
    ) -> Self {
        DesktopSession {
            mode,
            capturer,
            input,
            video: Video::new(),
            cursor: CursorTracker::default(),
            pacer: Pacer::new(now, DEFAULT_TILE_FPS),
            started: now,
            greeted: false,
            bad_messages: 0,
            told_not_allowed: false,
            logged_types: HashSet::new(),
            viewport: None,
            scale: Scale::Fit,
            ended: None,
            follow: None,
            wants_all: false,
            sharing: clipboard::Sharing::default(),
        }
    }

    pub fn mode(&self) -> Mode {
        self.mode
    }

    /// The video's figures since the last call, and the capture path now
    /// in use (SPEC-DIAGNOSTICS 3).
    pub fn take_figures(&mut self) -> (Figures, &'static str) {
        (self.video.take_figures(), self.capturer.backend())
    }

    /// Why the session ended, once it has.
    pub fn ended(&self) -> Option<EndReason> {
        self.ended
    }

    /// When to call [`DesktopSession::tick`] next. Before `hello` nothing is
    /// captured, so it only wakes once a second.
    pub fn next_tick(&self, now: Instant) -> Instant {
        if self.greeted {
            self.waiting_for_screen()
                .unwrap_or_else(|| self.pacer.next_tick())
        } else {
            now + Duration::from_secs(1)
        }
    }

    /// Ends the session: releases every held key and button, then says
    /// `ended`. Later calls do nothing.
    pub fn end(&mut self, reason: EndReason) -> Vec<Outgoing> {
        if self.ended.is_some() {
            return Vec::new();
        }
        self.ended = Some(reason);
        // Dropping the controller releases everything it holds.
        self.input = None;
        self.stop_waking();
        vec![text(AgentMessage::Ended { reason })]
    }

    /// One text frame from the browser.
    pub fn handle_text(&mut self, text_frame: &str, now: Instant) -> Vec<Outgoing> {
        if self.ended.is_some() {
            return Vec::new();
        }
        let mut out = Vec::new();
        match control::parse(text_frame) {
            Parsed::Unknown(kind) => self.log_once(&kind, "unknown desktop message type"),
            Parsed::Bad(reason) => self.bad_message(&reason, &mut out),
            Parsed::Message(message) => {
                if !self.greeted && !matches!(message, ClientMessage::Hello { .. }) {
                    self.bad_message("a message came before hello", &mut out);
                } else if message.needs_control() && self.mode == Mode::Watch {
                    if !self.told_not_allowed {
                        self.told_not_allowed = true;
                        log::warn!("Desktop session is watch-only; dropped a control message");
                        out.push(error(
                            ErrorCode::NotAllowed,
                            "This session can only watch the screen",
                        ));
                    }
                } else {
                    self.handle(message, now, &mut out);
                }
            }
        }
        out
    }

    fn bad_message(&mut self, reason: &str, out: &mut Vec<Outgoing>) {
        self.bad_messages += 1;
        log::warn!("Bad desktop message ({}): {reason}", self.bad_messages);
        out.push(error(ErrorCode::BadMessage, reason));
        if self.bad_messages >= MAX_BAD_MESSAGES {
            out.extend(self.end(EndReason::Closed));
        }
    }

    fn log_once(&mut self, kind: &str, what: &str) {
        if self.logged_types.insert(kind.to_string()) {
            log::info!("Ignoring {what}: {kind}");
        }
    }

    fn handle(&mut self, message: ClientMessage, now: Instant, out: &mut Vec<Outgoing>) {
        match message {
            ClientMessage::Hello { codecs, viewport } => {
                if !codecs.contains(&Codec::Jpeg) {
                    out.push(error(
                        ErrorCode::EncoderFailed,
                        "This agent sends JPEG tiles only, and the browser did not offer them",
                    ));
                    out.extend(self.end(EndReason::Closed));
                    return;
                }
                self.greeted = true;
                self.viewport = Some(viewport);
                // A new page has no cursor shapes and no stream yet.
                self.cursor.restart();
                self.video.restart();
                self.pacer.force_keyframe();
                out.push(self.displays_message());
                out.push(self.state_message());
            }
            ClientMessage::AskApproval => self.request_screen_approval(now, out),
            ClientMessage::Keyframe => {
                if self.pacer.request_keyframe(now) {
                    self.video.refresh();
                }
            }
            ClientMessage::Ack { seq } => {
                self.pacer.ack(seq, now);
            }
            ClientMessage::SelectDisplay { display } => {
                let view = if display == ALL_DISPLAYS {
                    if !self.capturer.can_show_all() {
                        self.bad_message("this screen cannot show every display at once", out);
                        return;
                    }
                    View::All
                } else {
                    let Some(index) = self
                        .capturer
                        .displays()
                        .iter()
                        .position(|d| d.id == display)
                    else {
                        self.bad_message(&format!("no display {display:?}"), out);
                        return;
                    };
                    View::Display(index)
                };
                self.release_all();
                if let Err(err) = self.capturer.select(view) {
                    out.push(error(ErrorCode::CaptureFailed, &err.0));
                    return;
                }
                self.wants_all = view == View::All;
                self.video.refresh();
                self.pacer.force_keyframe();
                self.cursor.forget_position();
                out.push(self.displays_message());
            }
            ClientMessage::Settings {
                quality,
                scale,
                max_fps,
                auto_start,
            } => {
                let start = auto_start.unwrap_or(crate::auto_quality::START);
                if self.pacer.set_quality(quality, start, now) {
                    self.video.refresh();
                }
                self.pacer.set_max_fps(max_fps);
                self.scale = scale;
                out.extend(self.auto_news());
            }
            ClientMessage::Disconnect => out.extend(self.end(EndReason::Closed)),
            ClientMessage::ClipboardPush { text } => self.clipboard_push(&text, out),
            ClientMessage::ClipboardPull => self.clipboard_pull(out),
            ClientMessage::ClipboardShare { on } => self.sharing.turn(on, now),
            ClientMessage::ClipboardSync { text } => self.clipboard_sync(&text, out),
            message => self.inject(message, now, out),
        }
    }

    fn inject(&mut self, message: ClientMessage, now: Instant, out: &mut Vec<Outgoing>) {
        let display = self.current_rect();
        if self.input.is_some() {
            self.viewer_input(now);
        }
        let Some(input) = self.input.as_mut() else {
            return;
        };
        let typing = matches!(message, ClientMessage::Text { .. });
        let result = match message {
            ClientMessage::Pointer { x, y, buttons } => input.pointer(display, x, y, buttons),
            ClientMessage::Wheel { dx, dy, mode } => input.wheel(dx, dy, mode),
            ClientMessage::Key {
                code,
                key,
                down,
                alt_gr,
            } => input.key(&code, &key, down, alt_gr),
            ClientMessage::Text { text } => input.text(&text),
            ClientMessage::Special { name } => input.special(name),
            ClientMessage::ReleaseAll => input.release_all(),
            _ => Ok(()),
        };
        if let Err(err) = result {
            log::warn!("Desktop input failed: {err}");
            // Text the screen cannot type is the viewer's to know about.
            if typing {
                out.push(error(ErrorCode::InputFailed, &err.0));
            }
        }
    }

    fn release_all(&mut self) {
        if let Some(input) = self.input.as_mut() {
            if let Err(err) = input.release_all() {
                log::warn!("Releasing held keys failed: {err}");
            }
        }
    }

    /// What the view covers on the desktop: the input backend's coordinates.
    fn current_rect(&self) -> Rect {
        shown_rect(self.capturer.displays(), self.capturer.view()).unwrap_or(Rect::new(0, 0, 1, 1))
    }

    fn displays_message(&self) -> Outgoing {
        let list = self.capturer.displays().to_vec();
        let current = view_id(&list, self.capturer.view());
        text(AgentMessage::Displays {
            list,
            current,
            all_screens: self.capturer.can_show_all(),
        })
    }

    /// One capture tick: maybe a frame, then the cursor.
    pub fn tick(&mut self, now: Instant) -> Vec<Outgoing> {
        let mut out = Vec::new();
        if !self.greeted || self.ended.is_some() {
            return out;
        }
        if !self.follow_screen(now, &mut out) {
            return out;
        }
        self.keep_awake(now);
        self.watch_clipboard(now, &mut out);
        match self.capturer.poll_layout() {
            Ok(true) => {
                self.release_all();
                self.video.refresh();
                self.pacer.force_keyframe();
                out.push(self.displays_message());
                // A following session says again what the screen shows, so
                // a resolution or monitor change reads like a switch.
                if self.follow.is_some() {
                    out.push(self.state_message());
                }
            }
            Ok(false) => {}
            Err(err) => {
                out.extend(self.capture_failed(now, &err.0));
                return out;
            }
        }

        let decision = self.pacer.tick(now);
        out.extend(self.auto_news());
        match decision {
            TickDecision::Stalled { newly } => {
                self.video.dropped();
                if newly {
                    log::info!("Desktop viewer sent no ack for 10 s; pausing frames");
                    out.push(text(AgentMessage::Stalled));
                }
            }
            TickDecision::WindowFull => self.video.dropped(),
            TickDecision::Capture { keyframe } => {
                let (scale, viewport) = (self.scale, self.viewport);
                let factor = move |width, height| scale_factor(scale, viewport, width, height);
                let quality = self.pacer.jpeg_quality();
                let pts = self.pts(now);
                match self.video.produce(
                    &mut *self.capturer,
                    &factor,
                    keyframe,
                    quality,
                    pts,
                    &mut out,
                ) {
                    Ok(Some(sent)) => self.pacer.sent(sent.seq, now, sent.keyframe),
                    Ok(None) => {}
                    Err(message) => {
                        out.extend(self.capture_failed(now, &message));
                        return out;
                    }
                }
            }
        }
        if let Some(stream) = self.video.stream() {
            let rect = self.current_rect();
            let (seq, pts) = (self.video.seq(), self.pts(now));
            self.cursor
                .update(&mut *self.capturer, stream, rect, seq, pts, &mut out);
        }
        out
    }

    /// `auto-quality` when Auto's level is news for the viewer.
    fn auto_news(&mut self) -> Option<Outgoing> {
        self.pacer
            .take_auto_news()
            .map(|level| text(AgentMessage::AutoQuality { level }))
    }

    fn capture_failed(&mut self, now: Instant, message: &str) -> Vec<Outgoing> {
        if self.follow.is_some() {
            return self.screen_lost(now, message);
        }
        log::error!("Desktop capture failed: {message}");
        let mut out = vec![error(ErrorCode::CaptureFailed, message)];
        out.extend(self.end(EndReason::AgentLost));
        out
    }

    fn pts(&self, now: Instant) -> u64 {
        now.saturating_duration_since(self.started).as_micros() as u64
    }
}

/// The encode factor for a captured image of `width × height`: the `scale`
/// setting, or for `fit` what fits the viewer's viewport (never above 1).
fn scale_factor(scale: Scale, viewport: Option<Viewport>, width: u32, height: u32) -> f64 {
    match (scale, viewport) {
        (Scale::Factor(factor), _) => factor,
        (Scale::Fit, Some(v)) if v.width > 0.0 && v.height > 0.0 && width > 0 && height > 0 => {
            let ratio = if v.pixel_ratio > 0.0 {
                v.pixel_ratio
            } else {
                1.0
            };
            (v.width * ratio / f64::from(width))
                .min(v.height * ratio / f64::from(height))
                .min(1.0)
        }
        (Scale::Fit, _) => 1.0,
    }
}

fn text(message: AgentMessage) -> Outgoing {
    Outgoing::Text(message.to_json())
}

fn error(code: ErrorCode, message: &str) -> Outgoing {
    text(AgentMessage::Error {
        code,
        message: message.to_string(),
    })
}

/// Longest wait between checks of the `stop` flag.
const STOP_POLL: Duration = Duration::from_millis(100);
/// How often [`run`] hands over the video's figures (SPEC-DIAGNOSTICS 3).
pub const FIGURES_EVERY: Duration = Duration::from_secs(30);

/// The video's figures over `interval`, and the capture path in use.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FiguresReport {
    pub figures: Figures,
    pub backend: &'static str,
    pub interval: Duration,
}

/// Runs a session until it ends: text frames from `incoming`, ticks on time,
/// everything produced goes to `send`. A closed channel or a failed send
/// ends the session with `agent-lost` (the socket is gone). `stop` is the
/// agent's shutdown flag, as the sessions pump takes it: once set, the
/// session releases every held key, says `ended` and returns. Every
/// `figures_every`, and whenever the capture path changes, the video's
/// figures go to `on_figures`.
pub fn run(
    session: &mut DesktopSession,
    incoming: &Receiver<Incoming>,
    send: &mut dyn FnMut(Outgoing) -> std::io::Result<()>,
    stop: &AtomicBool,
    figures_every: Duration,
    on_figures: &mut dyn FnMut(FiguresReport),
) -> EndReason {
    let mut figures_since = Instant::now();
    let mut backend = "";
    loop {
        if let Some(reason) = session.ended() {
            return reason;
        }
        let interval = figures_since.elapsed();
        if interval >= figures_every || session.capturer.backend() != backend {
            let (figures, now_backend) = session.take_figures();
            backend = now_backend;
            on_figures(FiguresReport {
                figures,
                backend,
                interval,
            });
            figures_since = Instant::now();
        }
        if stop.load(Ordering::SeqCst) {
            for message in session.end(EndReason::AgentLost) {
                let _ = send(message);
            }
            return EndReason::AgentLost;
        }
        let now = Instant::now();
        let deadline = session.next_tick(now).min(now + STOP_POLL);
        let out = if deadline <= now {
            session.tick(now)
        } else {
            match incoming.recv_timeout(deadline - now) {
                Ok(Incoming::Text(frame)) => session.handle_text(&frame, Instant::now()),
                Ok(Incoming::Binary(_)) => Vec::new(),
                Ok(Incoming::End(reason)) => session.end(reason),
                Err(RecvTimeoutError::Timeout) => Vec::new(),
                Err(RecvTimeoutError::Disconnected) => {
                    session.end(EndReason::AgentLost);
                    return EndReason::AgentLost;
                }
            }
        };
        for message in out {
            if let Err(err) = send(message) {
                log::warn!("Desktop session socket failed: {err}");
                session.end(EndReason::AgentLost);
                return EndReason::AgentLost;
            }
        }
    }
}

#[cfg(test)]
mod tests;
