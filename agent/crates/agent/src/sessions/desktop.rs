//! A desktop session (SPEC-DESKTOP): the screen of this machine's console
//! for one viewer. The `bmuster-desktop` crate does the work; this joins it
//! to the session socket.
//!
//! Threads: the pump (socket) and the desktop loop. The browser's text
//! frames go to the loop as they come; frames and control messages come
//! back through a small bounded channel, so a slow socket holds the loop
//! back instead of piling frames up (the loop's own pacing keeps it far
//! below that). The loop's last message is `ended` with the reason, which
//! the server reads as the session's last word.

use super::pump::{pump, Ended, Incoming as FromServer, Outgoing as ToServer};
use crate::socket::Socket;
use anyhow::{anyhow, bail, Context as _, Result};
use bmuster_desktop::control::{AgentMessage, ErrorCode};
use bmuster_desktop::{
    notice, Console, DesktopSession, EndReason, Incoming, Mode, Outgoing, Platform, SessionSlot,
};
use bmuster_protocol::session::Consent;
use std::sync::atomic::AtomicBool;
use std::sync::mpsc::{self, Sender};
use std::sync::Arc;
use std::time::Instant;
use tungstenite::Message;

/// Frames waiting for the socket before the desktop loop waits too. The
/// pacing window (2–3 frames, each maybe several batches) fits well inside.
const OUTPUT_QUEUE: usize = 16;

/// What the ticket asks for.
pub struct Request<'a> {
    pub permissions: &'a [String],
    pub consent: Consent,
    pub notice: bool,
}

/// A session that can start, or the machine is full.
pub enum Prepared {
    Ready(Box<Ready>),
    /// Already [`bmuster_desktop::session::MAX_SESSIONS`] desktop sessions.
    Busy,
}

pub struct Ready {
    session: DesktopSession,
    /// `Some` when the ticket asks for the notice bar: on this target, or
    /// with `None` on the screen a following session placed it on.
    notice: Option<Option<notice::Target>>,
    slot: SessionSlot,
}

/// Checks the ticket's terms and opens the screen. Errors are reported to
/// the console as `failed`.
pub fn prepare(
    request: &Request<'_>,
    open: impl FnOnce() -> Result<Console, String>,
) -> Result<Prepared> {
    if request.consent == Consent::Ask {
        // The server refuses these until the consent prompt exists; refuse
        // here too, so no screen is ever shown without the asked-for consent.
        bail!(
            "This session needs the person at the screen to allow it, and consent prompts are not built yet."
        );
    }
    let mode = Mode::from_permissions(request.permissions).map_err(|e| anyhow!(e))?;
    let Some(slot) = SessionSlot::try_acquire() else {
        return Ok(Prepared::Busy);
    };
    let now = Instant::now();
    let (session, notice_target) =
        match open().map_err(|e| anyhow!("Cannot open the screen: {e}"))? {
            Console::Fixed(Platform {
                capturer,
                make_input,
                notice_target,
            }) => (
                DesktopSession::new(mode, capturer, make_input, now)
                    .map_err(|e| anyhow!("Cannot control the screen: {e}"))?,
                Some(notice_target),
            ),
            // Opens what the screen shows now; waits with a reason when it
            // shows nothing BMuster can capture.
            Console::Following(watch) => (DesktopSession::following(mode, watch, now), None),
        };
    Ok(Prepared::Ready(Box::new(Ready {
        session,
        notice: request.notice.then_some(notice_target),
        slot,
    })))
}

/// Tells the browser the machine already has its most desktop sessions,
/// then ends the session with `too-many-sessions`.
pub fn refuse_busy(socket: &mut Socket) -> Result<Ended> {
    let messages = [
        AgentMessage::Error {
            code: ErrorCode::TooManySessions,
            message: format!(
                "This machine already has {} desktop sessions open.",
                bmuster_desktop::session::MAX_SESSIONS
            ),
        },
        AgentMessage::Ended {
            reason: EndReason::TooManySessions,
        },
    ];
    for message in messages {
        socket
            .send(Message::text(message.to_json()))
            .context("could not refuse the session")?;
    }
    let _ = socket.close(None);
    let _ = socket.flush();
    Ok(Ended::Finished)
}

/// Runs the session over `socket` until it ends from either side or `stop`.
pub fn run(
    socket: &mut Socket,
    ready: Ready,
    viewer: &str,
    stop: &Arc<AtomicBool>,
) -> Result<Ended> {
    let Ready {
        mut session,
        notice,
        slot,
    } = ready;
    let (output, outgoing) = mpsc::sync_channel::<ToServer>(OUTPUT_QUEUE);
    let (to_session, incoming) = mpsc::channel::<Incoming>();
    let shown = notice.map(|target| notice::show(target.as_ref(), viewer, to_session.clone()));
    let worker = {
        let stop = Arc::clone(stop);
        std::thread::Builder::new()
            .name("desktop".into())
            .spawn(move || {
                let mut send = |message: Outgoing| {
                    let message = match message {
                        Outgoing::Binary(bytes) => ToServer::Bytes(bytes),
                        Outgoing::Text(text) => ToServer::Text(text),
                    };
                    output.send(message).map_err(|_| {
                        std::io::Error::new(std::io::ErrorKind::BrokenPipe, "the socket is gone")
                    })
                };
                let reason = bmuster_desktop::run(&mut session, &incoming, &mut send, &stop);
                // Off the bar and out of the count before the socket closes.
                drop(shown);
                drop(slot);
                reason
            })
            .context("could not start the desktop thread")?
    };

    let closer: Sender<Incoming> = to_session.clone();
    let ended = pump(
        socket,
        &outgoing,
        stop,
        || true,
        |message| {
            if let FromServer::Text(text) = message {
                // The loop only stops listening once it has ended.
                let _ = to_session.send(Incoming::Text(text));
            }
            Ok(())
        },
    );
    // The server closed or the socket broke: end the loop (it releases every
    // held key), and let a send it is blocked on fail.
    let _ = closer.send(Incoming::End(match &ended {
        Ok(Ended::ServerClosed) => EndReason::Closed,
        Ok(Ended::Finished) | Ok(Ended::Stopped) | Err(_) => EndReason::AgentLost,
    }));
    drop(outgoing);
    match worker.join() {
        Ok(reason) => log::info!("Desktop session for {viewer} ended: {reason:?}"),
        Err(_) => log::error!("The desktop thread for {viewer} panicked"),
    }
    ended
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::super::testing::{socket_pair, Server};
    use super::*;
    use bmuster_desktop::capture::{
        CaptureResult, Capturer, CursorImage, CursorState, Damage, DesktopState, DisplayInfo, Frame,
    };
    use bmuster_desktop::input::{InputBackend, InputResult};
    use bmuster_desktop::{Look, ScreenWatch};
    use serde_json::Value;

    /// A still 128×64 screen.
    struct Still {
        displays: Vec<DisplayInfo>,
        frame: Frame,
    }

    impl Still {
        fn new() -> Self {
            Still {
                displays: vec![DisplayInfo {
                    id: "screen-0".into(),
                    name: "Screen".into(),
                    x: 0,
                    y: 0,
                    width: 128,
                    height: 64,
                    scale: 1.0,
                    primary: true,
                }],
                frame: Frame::new(128, 64),
            }
        }
    }

    impl Capturer for Still {
        fn displays(&self) -> &[DisplayInfo] {
            &self.displays
        }
        fn current(&self) -> usize {
            0
        }
        fn select(&mut self, _index: usize) -> CaptureResult<()> {
            Ok(())
        }
        fn poll_layout(&mut self) -> CaptureResult<bool> {
            Ok(false)
        }
        fn capture(&mut self, full: bool) -> CaptureResult<Damage> {
            Ok(if full { Damage::Unknown } else { Damage::None })
        }
        fn frame(&self) -> &Frame {
            &self.frame
        }
        fn cursor(&mut self) -> CaptureResult<CursorState> {
            Ok(CursorState {
                id: 1,
                x: 0,
                y: 0,
                visible: false,
            })
        }
        fn cursor_image(&mut self, _id: u32) -> CaptureResult<Option<CursorImage>> {
            Ok(None)
        }
        fn state(&self) -> DesktopState {
            DesktopState::Desktop { user: None }
        }
    }

    fn still_platform() -> Result<Console, String> {
        Ok(Console::Fixed(Platform {
            capturer: Box::new(Still::new()),
            make_input: Box::new(|| -> InputResult<Box<dyn InputBackend>> {
                panic!("a watch-only session never builds an injector")
            }),
            notice_target: test_notice_target(),
        }))
    }

    /// A screen that shows a text console the whole time.
    struct TextConsole;

    impl ScreenWatch for TextConsole {
        fn look(&mut self) -> Look {
            Look {
                key: "1:tty".into(),
                state: DesktopState::Unavailable {
                    reason: "Text console".into(),
                },
            }
        }
        fn open(&mut self) -> Result<Platform, String> {
            panic!("a text console is never opened")
        }
    }

    fn test_notice_target() -> notice::Target {
        bmuster_desktop::capture::x11_session::X11Target {
            display: ":99999".into(),
            xauthority: None,
        }
    }

    fn request<'a>(permissions: &'a [String], consent: Consent) -> Request<'a> {
        Request {
            permissions,
            consent,
            notice: false,
        }
    }

    #[test]
    fn an_ask_ticket_is_refused_before_the_screen_is_opened() {
        let permissions = vec!["desktop-view".to_string()];
        let opened = std::cell::Cell::new(false);
        let result = prepare(&request(&permissions, Consent::Ask), || {
            opened.set(true);
            still_platform()
        });
        assert!(result.is_err());
        assert!(!opened.get(), "the screen was not opened");
    }

    #[test]
    fn a_ticket_without_desktop_view_is_refused() {
        let permissions = vec!["desktop-control".to_string()];
        assert!(prepare(&request(&permissions, Consent::Unattended), still_platform).is_err());
    }

    #[test]
    fn a_watch_session_sends_frames_and_ends_with_its_reason() {
        let permissions = vec!["desktop-view".to_string()];
        let Ok(Prepared::Ready(ready)) =
            prepare(&request(&permissions, Consent::Unattended), still_platform)
        else {
            panic!("the session did not start");
        };
        let (mut client, server) = socket_pair();
        let agent = std::thread::spawn(move || {
            let stop = Arc::new(AtomicBool::new(false));
            run(&mut client, *ready, "Jack", &stop).unwrap()
        });
        let mut server = Server::new(server);
        server.send_text(
            r#"{"type":"hello","codecs":["jpeg"],"viewport":{"width":800,"height":600,"pixelRatio":1}}"#,
        );
        let displays: Value = serde_json::from_str(&server.wait_for_text()).unwrap();
        assert_eq!(displays["type"], "displays");
        assert_eq!(displays["current"], "screen-0");
        server.send_text(r#"{"type":"pointer","x":1,"y":1,"buttons":1}"#);
        server.send_text(r#"{"type":"disconnect"}"#);
        let mut texts = Vec::new();
        while !texts.iter().any(|t: &String| t.contains("\"ended\"")) {
            texts.push(server.wait_for_text());
        }
        assert!(
            texts.iter().any(|t| t.contains("not-allowed")),
            "watch-only says no to input: {texts:?}"
        );
        assert_eq!(
            texts.last().map(String::as_str),
            Some(r#"{"type":"ended","reason":"closed"}"#)
        );
        // The keyframe came first: a tile batch (type 2), keyframe and last part.
        let output = server.output();
        assert_eq!(output[0], 2);
        assert_eq!(output[2] & 0b101, 0b101);
        server.close();
        assert_eq!(agent.join().unwrap(), Ended::Finished);
    }

    #[test]
    fn a_following_session_with_nothing_to_show_stays_open_with_the_reason() {
        let permissions = vec!["desktop-view".to_string(), "desktop-control".to_string()];
        let Ok(Prepared::Ready(ready)) =
            prepare(&request(&permissions, Consent::Unattended), || {
                Ok(Console::Following(Box::new(TextConsole)))
            })
        else {
            panic!("the session did not start");
        };
        let (mut client, server) = socket_pair();
        let agent = std::thread::spawn(move || {
            let stop = Arc::new(AtomicBool::new(false));
            run(&mut client, *ready, "Jack", &stop).unwrap()
        });
        let mut server = Server::new(server);
        server.send_text(
            r#"{"type":"hello","codecs":["jpeg"],"viewport":{"width":800,"height":600,"pixelRatio":1}}"#,
        );
        assert_eq!(
            server.wait_for_text(),
            r#"{"type":"displays","list":[],"current":""}"#
        );
        assert_eq!(
            server.wait_for_text(),
            r#"{"type":"state","screen":{"kind":"unavailable","reason":"Text console"}}"#
        );
        server.send_text(r#"{"type":"pointer","x":1,"y":1,"buttons":1}"#);
        server.send_text(r#"{"type":"disconnect"}"#);
        assert_eq!(
            server.wait_for_text(),
            r#"{"type":"ended","reason":"closed"}"#
        );
        assert!(server.output().is_empty(), "no frames without a screen");
        server.close();
        assert_eq!(agent.join().unwrap(), Ended::Finished);
    }
}
