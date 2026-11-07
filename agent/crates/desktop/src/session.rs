//! One viewer's desktop session: control messages in, frames out.
//!
//! [`DesktopSession`] is driven from outside: the caller feeds it the
//! browser's text frames ([`DesktopSession::handle_text`]) and calls
//! [`DesktopSession::tick`] when [`DesktopSession::next_tick`] is due. Both
//! return the messages to send. [`run`] is that loop over a channel, for the
//! session socket code to drive.

use crate::capture::{Capturer, Damage, Frame};
use crate::control::{
    self, AgentMessage, ClientMessage, Codec, EndReason, ErrorCode, Mode, Parsed, Scale, Viewport,
};
use crate::encode::{png, scale, tiles::TileEncoder};
use crate::frame::{self, CursorContext, FrameInfo};
use crate::input::{InputBackend, InputController, InputResult};
use crate::pacing::{Pacer, TickDecision};
use std::collections::HashSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError};
use std::time::{Duration, Instant};

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

/// The stream parameters a `stream` message announces.
#[derive(Debug, Clone, Copy, PartialEq)]
struct StreamKey {
    display: usize,
    width: u32,
    height: u32,
    scale: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CursorSent {
    id: u32,
    x: i32,
    y: i32,
    visible: bool,
}

pub struct DesktopSession {
    mode: Mode,
    capturer: Box<dyn Capturer>,
    /// Only built for a control session (SPEC-DESKTOP 7).
    input: Option<InputController>,
    encoder: TileEncoder,
    pacer: Pacer,
    started: Instant,
    greeted: bool,
    seq: u32,
    bad_messages: u32,
    told_not_allowed: bool,
    logged_types: HashSet<String>,
    viewport: Option<Viewport>,
    scale: Scale,
    scaled: Frame,
    stream: Option<StreamKey>,
    shapes_sent: HashSet<u32>,
    cursor_sent: Option<CursorSent>,
    cursor_failed: bool,
    ended: Option<EndReason>,
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
        Ok(DesktopSession {
            mode,
            capturer,
            input,
            encoder: TileEncoder::new(),
            pacer: Pacer::new(now, DEFAULT_TILE_FPS),
            started: now,
            greeted: false,
            seq: 0,
            bad_messages: 0,
            told_not_allowed: false,
            logged_types: HashSet::new(),
            viewport: None,
            scale: Scale::Fit,
            scaled: Frame::new(0, 0),
            stream: None,
            shapes_sent: HashSet::new(),
            cursor_sent: None,
            cursor_failed: false,
            ended: None,
        })
    }

    pub fn mode(&self) -> Mode {
        self.mode
    }

    /// Why the session ended, once it has.
    pub fn ended(&self) -> Option<EndReason> {
        self.ended
    }

    /// When to call [`DesktopSession::tick`] next. Before `hello` nothing is
    /// captured, so it only wakes once a second.
    pub fn next_tick(&self, now: Instant) -> Instant {
        if self.greeted {
            self.pacer.next_tick()
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
                self.shapes_sent.clear();
                self.cursor_sent = None;
                self.stream = None;
                self.encoder.reset();
                self.pacer.force_keyframe();
                out.push(self.displays_message());
                out.push(text(AgentMessage::State(self.capturer.state())));
            }
            ClientMessage::Keyframe => {
                if self.pacer.request_keyframe(now) {
                    self.encoder.reset();
                }
            }
            ClientMessage::Ack { seq } => {
                self.pacer.ack(seq, now);
            }
            ClientMessage::SelectDisplay { display } => {
                let Some(index) = self
                    .capturer
                    .displays()
                    .iter()
                    .position(|d| d.id == display)
                else {
                    self.bad_message(&format!("no display {display:?}"), out);
                    return;
                };
                self.release_all();
                if let Err(err) = self.capturer.select(index) {
                    out.push(error(ErrorCode::CaptureFailed, &err.0));
                    return;
                }
                self.encoder.reset();
                self.pacer.force_keyframe();
                self.cursor_sent = None;
                out.push(self.displays_message());
            }
            ClientMessage::Settings {
                quality,
                scale,
                max_fps,
            } => {
                if self.pacer.set_quality(quality, now) {
                    self.encoder.reset();
                }
                self.pacer.set_max_fps(max_fps);
                self.scale = scale;
            }
            ClientMessage::Disconnect => out.extend(self.end(EndReason::Closed)),
            ClientMessage::ClipboardPush { .. } | ClientMessage::ClipboardPull => {
                self.log_once("clipboard", "message (clipboard comes in phase 6)");
            }
            message => self.inject(message),
        }
    }

    fn inject(&mut self, message: ClientMessage) {
        let display = self.current_rect();
        let Some(input) = self.input.as_mut() else {
            return;
        };
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
        }
    }

    fn release_all(&mut self) {
        if let Some(input) = self.input.as_mut() {
            if let Err(err) = input.release_all() {
                log::warn!("Releasing held keys failed: {err}");
            }
        }
    }

    fn current_rect(&self) -> crate::capture::Rect {
        self.capturer
            .displays()
            .get(self.capturer.current())
            .map(|d| d.rect())
            .unwrap_or(crate::capture::Rect::new(0, 0, 1, 1))
    }

    fn displays_message(&self) -> Outgoing {
        let list = self.capturer.displays().to_vec();
        let current = list
            .get(self.capturer.current())
            .map(|d| d.id.clone())
            .unwrap_or_default();
        text(AgentMessage::Displays { list, current })
    }

    fn scale_factor(&self) -> f64 {
        let rect = self.current_rect();
        match (self.scale, self.viewport) {
            (Scale::Factor(factor), _) => factor,
            (Scale::Fit, Some(v)) if v.width > 0.0 && v.height > 0.0 => {
                let ratio = if v.pixel_ratio > 0.0 {
                    v.pixel_ratio
                } else {
                    1.0
                };
                (v.width * ratio / f64::from(rect.width))
                    .min(v.height * ratio / f64::from(rect.height))
                    .min(1.0)
            }
            (Scale::Fit, _) => 1.0,
        }
    }

    /// One capture tick: maybe a frame, then the cursor.
    pub fn tick(&mut self, now: Instant) -> Vec<Outgoing> {
        let mut out = Vec::new();
        if !self.greeted || self.ended.is_some() {
            return out;
        }
        match self.capturer.poll_layout() {
            Ok(true) => {
                self.release_all();
                self.encoder.reset();
                self.pacer.force_keyframe();
                out.push(self.displays_message());
            }
            Ok(false) => {}
            Err(err) => return self.capture_failed(&err.0),
        }

        match self.pacer.tick(now) {
            TickDecision::Stalled { newly } => {
                if newly {
                    log::info!("Desktop viewer sent no ack for 10 s; pausing frames");
                    out.push(text(AgentMessage::Stalled));
                }
            }
            TickDecision::WindowFull => {}
            TickDecision::Capture { keyframe } => {
                if let Err(message) = self.frame(now, keyframe, &mut out) {
                    out.extend(self.capture_failed(&message));
                    return out;
                }
            }
        }
        self.cursor(now, &mut out);
        out
    }

    fn capture_failed(&mut self, message: &str) -> Vec<Outgoing> {
        log::error!("Desktop capture failed: {message}");
        let mut out = vec![error(ErrorCode::CaptureFailed, message)];
        out.extend(self.end(EndReason::AgentLost));
        out
    }

    fn frame(
        &mut self,
        now: Instant,
        keyframe: bool,
        out: &mut Vec<Outgoing>,
    ) -> Result<(), String> {
        let damage = self.capturer.capture(keyframe).map_err(|e| e.0)?;
        let factor = self.scale_factor();
        let source = self.capturer.frame();
        let (width, height) = scale::scaled_size(source.width, source.height, factor);
        let scaled = (width, height) != (source.width, source.height);
        let damage = if scaled {
            if (self.scaled.width, self.scaled.height) != (width, height) {
                self.scaled = Frame::new(width, height);
            }
            if damage != Damage::None {
                scale::downscale(source, &mut self.scaled);
            }
            scale::scale_damage(&damage, (source.width, source.height), (width, height))
        } else {
            damage
        };
        let frame = if scaled { &self.scaled } else { source };

        let key = StreamKey {
            display: self.capturer.current(),
            width,
            height,
            scale: if scaled { factor } else { 1.0 },
        };
        let new_stream = self.stream != Some(key);
        let size_changed = self
            .stream
            .is_some_and(|old| (old.width, old.height) != (width, height));
        let encoded = self
            .encoder
            .encode(
                frame,
                &damage,
                keyframe || new_stream,
                self.pacer.jpeg_quality(),
            )
            .map_err(|e| e.0)?;
        if encoded.tiles.is_empty() && !encoded.keyframe {
            return Ok(());
        }
        if new_stream {
            let display = self
                .capturer
                .displays()
                .get(key.display)
                .map(|d| d.id.clone())
                .unwrap_or_default();
            out.push(text(AgentMessage::Stream {
                display,
                codec: Codec::Jpeg,
                width,
                height,
                scale: key.scale,
            }));
            self.stream = Some(key);
        }

        self.seq = match self.seq.wrapping_add(1) {
            0 => 1,
            seq => seq,
        };
        let info = FrameInfo {
            display: key.display as u8,
            seq: self.seq,
            pts: self.pts(now),
            width: width as u16,
            height: height as u16,
            keyframe: encoded.keyframe,
            size_changed,
        };
        for batch in frame::tile_batches(info, &encoded.tiles, frame::MAX_BATCH_BYTES) {
            out.push(Outgoing::Binary(batch));
        }
        self.pacer.sent(self.seq, now, encoded.keyframe);
        Ok(())
    }

    fn pts(&self, now: Instant) -> u64 {
        now.saturating_duration_since(self.started).as_micros() as u64
    }

    fn cursor(&mut self, now: Instant, out: &mut Vec<Outgoing>) {
        let state = match self.capturer.cursor() {
            Ok(state) => state,
            Err(err) => {
                if !self.cursor_failed {
                    self.cursor_failed = true;
                    log::warn!("Reading the cursor failed: {}", err.0);
                }
                return;
            }
        };
        let Some(stream) = self.stream else {
            return;
        };
        let rect = self.current_rect();
        let inside = state.x >= rect.x
            && state.y >= rect.y
            && i64::from(state.x) < i64::from(rect.x) + i64::from(rect.width)
            && i64::from(state.y) < i64::from(rect.y) + i64::from(rect.height);
        let sent = CursorSent {
            id: state.id,
            x: (f64::from(state.x - rect.x) * stream.scale).round() as i32,
            y: (f64::from(state.y - rect.y) * stream.scale).round() as i32,
            visible: state.visible && inside,
        };
        let context = CursorContext {
            display: stream.display as u8,
            seq: self.seq,
            pts: self.pts(now),
            width: stream.width as u16,
            height: stream.height as u16,
        };
        if sent.visible && !self.shapes_sent.contains(&sent.id) {
            match self.capturer.cursor_image(sent.id) {
                Ok(Some(image)) => {
                    let png = png::encode_rgba(image.width, image.height, &image.rgba);
                    let hotspot = (image.hotspot_x as u16, image.hotspot_y as u16);
                    out.push(Outgoing::Binary(frame::cursor_shape(
                        context, sent.id, hotspot, &png,
                    )));
                    self.shapes_sent.insert(sent.id);
                }
                // The shape changed again before it was read: next tick.
                Ok(None) => return,
                Err(err) => {
                    log::warn!("Reading the cursor shape failed: {}", err.0);
                    return;
                }
            }
        }
        if self.cursor_sent != Some(sent) {
            out.push(Outgoing::Binary(frame::cursor_position(
                context,
                sent.id,
                sent.x,
                sent.y,
                sent.visible,
            )));
            self.cursor_sent = Some(sent);
        }
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

/// Runs a session until it ends: text frames from `incoming`, ticks on time,
/// everything produced goes to `send`. A closed channel or a failed send
/// ends the session with `agent-lost` (the socket is gone).
pub fn run(
    session: &mut DesktopSession,
    incoming: &Receiver<Incoming>,
    send: &mut dyn FnMut(Outgoing) -> std::io::Result<()>,
) -> EndReason {
    loop {
        if let Some(reason) = session.ended() {
            return reason;
        }
        let now = Instant::now();
        let deadline = session.next_tick(now);
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
#[path = "session_tests.rs"]
mod tests;
