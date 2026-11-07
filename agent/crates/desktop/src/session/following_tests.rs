//! The following session's state machine, with a fake screen watch: user
//! desktop to sign-in screen and back, lock and unlock, Wayland, a text
//! console, no seat, a screen that will not open and capture that fails.

use super::*;
use crate::capture::{
    CaptureError, CaptureResult, Capturer, CursorImage, CursorState, Damage, DisplayInfo, Frame,
};
use crate::follow::Look;
use crate::frame::FLAG_KEYFRAME;
use crate::input::recording::{Call, Recorder};
use crate::input::{Button, InputBackend, InputResult};
use crate::session::DesktopSession;
use crate::Platform;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

/// One fake screen: a solid colour, its own injector, and a switch that
/// makes capture fail.
#[derive(Clone)]
struct FakeScreen {
    id: &'static str,
    width: u32,
    recorder: Recorder,
    broken: Arc<AtomicBool>,
}

impl FakeScreen {
    fn new(id: &'static str, width: u32) -> Self {
        FakeScreen {
            id,
            width,
            recorder: Recorder::default(),
            broken: Arc::new(AtomicBool::new(false)),
        }
    }
}

struct SolidCapturer {
    displays: Vec<DisplayInfo>,
    frame: Frame,
    broken: Arc<AtomicBool>,
}

impl Capturer for SolidCapturer {
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
        if self.broken.load(Ordering::SeqCst) {
            return Err(CaptureError::new("the X server went away"));
        }
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

/// What the fake seat shows; the test changes it between ticks.
struct Seat {
    look: Look,
    screens: HashMap<String, FakeScreen>,
    opened: Vec<String>,
    refuse: Option<String>,
    built_injectors: u32,
}

#[derive(Clone)]
struct FakeWatch(Arc<Mutex<Seat>>);

impl ScreenWatch for FakeWatch {
    fn look(&mut self) -> Look {
        self.0.lock().unwrap().look.clone()
    }

    fn open(&mut self) -> Result<Platform, String> {
        let mut seat = self.0.lock().unwrap();
        if let Some(reason) = &seat.refuse {
            return Err(reason.clone());
        }
        let key = seat.look.key.clone();
        let screen = seat
            .screens
            .get(&key)
            .cloned()
            .unwrap_or_else(|| panic!("opened {key}, which has no screen"));
        seat.opened.push(key);
        let mut frame = Frame::new(screen.width, 64);
        frame.fill(
            crate::capture::Rect::new(0, 0, screen.width, 64),
            [10, 20, 30, 0],
        );
        let watch = self.0.clone();
        let recorder = screen.recorder.clone();
        Ok(Platform {
            capturer: Box::new(SolidCapturer {
                displays: vec![DisplayInfo {
                    id: screen.id.to_string(),
                    name: screen.id.to_string(),
                    x: 0,
                    y: 0,
                    width: screen.width,
                    height: 64,
                    scale: 1.0,
                    primary: true,
                }],
                frame,
                broken: screen.broken.clone(),
            }),
            make_input: Box::new(move || -> InputResult<Box<dyn InputBackend>> {
                watch.lock().unwrap().built_injectors += 1;
                Ok(Box::new(recorder))
            }),
            notice_target: notice_target(),
        })
    }
}

#[cfg(target_os = "linux")]
fn notice_target() -> crate::notice::Target {
    crate::capture::x11_session::X11Target {
        display: ":99999".into(),
        xauthority: None,
    }
}

#[cfg(not(target_os = "linux"))]
fn notice_target() -> crate::notice::Target {
    crate::notice::Target
}

fn desktop(user: &str) -> DesktopState {
    DesktopState::Desktop {
        user: Some(user.to_string()),
    }
}

fn unavailable(reason: &str) -> DesktopState {
    DesktopState::Unavailable {
        reason: reason.to_string(),
    }
}

struct Harness {
    session: DesktopSession,
    seat: Arc<Mutex<Seat>>,
    a: FakeScreen,
    b: FakeScreen,
    now: Instant,
    _turn: std::sync::MutexGuard<'static, ()>,
}

const HELLO: &str =
    r#"{"type":"hello","codecs":["jpeg"],"viewport":{"width":4000,"height":4000,"pixelRatio":1}}"#;

/// Screen A (Jack's desktop, 128 wide) and screen B (the sign-in screen,
/// 96 wide); the seat starts on `first`.
fn harness(mode: Mode, first: Look) -> Harness {
    let turn = crate::notice::test_turn();
    let a = FakeScreen::new("A", 128);
    let b = FakeScreen::new("B", 96);
    let seat = Arc::new(Mutex::new(Seat {
        look: first,
        screens: HashMap::from([("a".to_string(), a.clone()), ("b".to_string(), b.clone())]),
        opened: Vec::new(),
        refuse: None,
        built_injectors: 0,
    }));
    let now = Instant::now();
    let session = DesktopSession::following(mode, Box::new(FakeWatch(seat.clone())), now);
    Harness {
        session,
        seat,
        a,
        b,
        now,
        _turn: turn,
    }
}

fn on_a() -> Look {
    Look {
        key: "a".into(),
        state: desktop("jack"),
    }
}

fn on_b() -> Look {
    Look {
        key: "b".into(),
        state: DesktopState::SignIn,
    }
}

impl Harness {
    fn send(&mut self, text: &str) -> Vec<Outgoing> {
        self.session.handle_text(text, self.now)
    }

    /// The seat now shows `look`; one second passes and the session ticks.
    fn switch(&mut self, look: Look) -> Vec<Outgoing> {
        self.seat.lock().unwrap().look = look;
        self.second()
    }

    fn second(&mut self) -> Vec<Outgoing> {
        self.now += LOOK_EVERY;
        self.tick_now()
    }

    /// A tick 100 ms on (within the same second's look).
    fn tick_soon(&mut self) -> Vec<Outgoing> {
        self.now += Duration::from_millis(100);
        self.tick_now()
    }

    /// Ticks, and acknowledges every frame like the browser does.
    fn tick_now(&mut self) -> Vec<Outgoing> {
        let out = self.session.tick(self.now);
        for message in &out {
            if let Outgoing::Binary(b) = message {
                if b[0] == 2 && b[2] & crate::frame::FLAG_LAST_PART != 0 {
                    let seq = u32::from_le_bytes([b[4], b[5], b[6], b[7]]);
                    self.session
                        .handle_text(&format!(r#"{{"type":"ack","seq":{seq}}}"#), self.now);
                }
            }
        }
        out
    }

    fn opened(&self) -> Vec<String> {
        self.seat.lock().unwrap().opened.clone()
    }
}

fn texts(out: &[Outgoing]) -> Vec<serde_json::Value> {
    out.iter()
        .filter_map(|m| match m {
            Outgoing::Text(t) => Some(serde_json::from_str(t).unwrap()),
            Outgoing::Binary(_) => None,
        })
        .collect()
}

fn of_type<'a>(out: &'a [serde_json::Value], kind: &str) -> Vec<&'a serde_json::Value> {
    out.iter().filter(|m| m["type"] == kind).collect()
}

/// The keyframe's width, when the output has one.
fn keyframe_width(out: &[Outgoing]) -> Option<u16> {
    out.iter().find_map(|m| match m {
        Outgoing::Binary(b) if b[0] == 2 && b[2] & FLAG_KEYFRAME != 0 => {
            // Header: type, display, flags, version, seq (4), pts (8), width, height.
            Some(u16::from_le_bytes([b[16], b[17]]))
        }
        _ => None,
    })
}

fn pointer(h: &mut Harness, x: u32) {
    h.send(&format!(
        r#"{{"type":"pointer","x":{x},"y":10,"buttons":0}}"#
    ));
}

#[test]
fn follow_user_to_greeter_and_back_reopens_and_sends_a_keyframe() {
    let mut h = harness(Mode::Control, on_a());
    let out = h.send(HELLO);
    let messages = texts(&out);
    assert_eq!(messages[0]["type"], "displays");
    assert_eq!(messages[0]["current"], "A");
    assert_eq!(
        messages[1],
        serde_json::json!({"type": "state", "screen": {"kind": "desktop", "user": "jack"}})
    );
    assert_eq!(keyframe_width(&h.second()), Some(128));
    pointer(&mut h, 5);
    assert_eq!(h.a.recorder.take(), vec![Call::Move(5, 10)]);

    // Signed out: the sign-in screen is another session.
    let out = h.switch(on_b());
    let messages = texts(&out);
    let displays = of_type(&messages, "displays");
    assert_eq!(displays.len(), 1, "straight to the new list: {displays:?}");
    assert_eq!(displays[0]["current"], "B");
    assert_eq!(
        of_type(&messages, "state")[0]["screen"],
        serde_json::json!({"kind": "sign-in"})
    );
    assert_eq!(of_type(&messages, "stream")[0]["width"], 96);
    assert_eq!(keyframe_width(&out), Some(96), "the stream goes on from B");
    assert!(h.session.ended().is_none());
    pointer(&mut h, 7);
    assert_eq!(h.b.recorder.take(), vec![Call::Move(7, 10)]);
    assert!(
        h.a.recorder.take().is_empty(),
        "nothing goes to the old screen"
    );

    // Signed in again.
    let out = h.switch(on_a());
    assert_eq!(keyframe_width(&out), Some(128));
    assert_eq!(h.opened(), vec!["a", "b", "a"]);
    assert_eq!(h.seat.lock().unwrap().built_injectors, 3);
}

#[test]
fn follow_switch_releases_held_buttons_on_the_old_screen() {
    let mut h = harness(Mode::Control, on_a());
    h.send(HELLO);
    h.second();
    h.send(r#"{"type":"pointer","x":5,"y":10,"buttons":1}"#);
    h.a.recorder.take();
    h.switch(on_b());
    assert!(
        h.a.recorder
            .take()
            .contains(&Call::Button(Button::Left, false)),
        "the left button is let go before the switch"
    );
}

#[test]
fn follow_lock_and_unlock_only_change_the_state() {
    let mut h = harness(Mode::Watch, on_a());
    h.send(HELLO);
    h.second();
    let out = h.switch(Look {
        key: "a".into(),
        state: DesktopState::Locked {
            user: Some("jack".into()),
        },
    });
    let messages = texts(&out);
    assert_eq!(messages.len(), 1, "{messages:?}");
    assert_eq!(
        messages[0]["screen"],
        serde_json::json!({"kind": "locked", "user": "jack"})
    );
    assert_eq!(keyframe_width(&out), None);
    let out = h.switch(on_a());
    assert_eq!(texts(&out)[0]["screen"]["kind"], "desktop");
    assert!(texts(&h.second()).is_empty(), "no news, no message");
    assert_eq!(h.opened(), vec!["a"]);
    assert_eq!(
        h.seat.lock().unwrap().built_injectors,
        0,
        "watch only never builds an injector"
    );
}

#[test]
fn follow_wayland_and_text_console_wait_open_with_a_reason() {
    let mut h = harness(Mode::Control, on_a());
    h.send(HELLO);
    h.second();
    let out = h.switch(Look {
        key: "c2:wayland".into(),
        state: unavailable("Wayland sign-in screen not supported yet"),
    });
    let messages = texts(&out);
    assert_eq!(
        of_type(&messages, "displays")[0]["list"],
        serde_json::json!([])
    );
    assert_eq!(
        of_type(&messages, "state")[0]["screen"],
        serde_json::json!({"kind": "unavailable", "reason": "Wayland sign-in screen not supported yet"})
    );
    pointer(&mut h, 3);
    assert!(h.a.recorder.take().is_empty());
    for _ in 0..3 {
        let out = h.second();
        assert!(out.is_empty(), "no frames and no news: {out:?}");
    }
    let out = h.switch(Look {
        key: "5:tty".into(),
        state: unavailable("Text console"),
    });
    assert_eq!(
        of_type(&texts(&out), "state")[0]["screen"]["reason"],
        "Text console"
    );
    assert!(h.session.ended().is_none());

    // An X session comes back: the stream resumes.
    let out = h.switch(on_b());
    assert_eq!(keyframe_width(&out), Some(96));
}

#[test]
fn follow_no_seat_at_the_start_waits_for_a_screen() {
    let mut h = harness(
        Mode::Watch,
        Look {
            key: "no-seat".into(),
            state: unavailable("Cannot find the screen (seat0)"),
        },
    );
    let messages = texts(&h.send(HELLO));
    assert_eq!(
        messages,
        vec![
            serde_json::json!({"type": "displays", "list": [], "current": ""}),
            serde_json::json!({"type": "state", "screen": {"kind": "unavailable", "reason": "Cannot find the screen (seat0)"}}),
        ]
    );
    assert!(h.second().is_empty());
    assert_eq!(keyframe_width(&h.switch(on_a())), Some(128));
}

#[test]
fn follow_a_screen_that_will_not_open_is_retried() {
    let mut h = harness(Mode::Watch, on_a());
    h.send(HELLO);
    h.second();
    h.seat.lock().unwrap().refuse = Some("bad cookie".into());
    let out = h.switch(on_b());
    assert_eq!(
        texts(&out)[1]["screen"],
        serde_json::json!({"kind": "unavailable", "reason": "Cannot open the screen: bad cookie"})
    );
    assert!(h.second().is_empty(), "the same failure is not repeated");
    h.seat.lock().unwrap().refuse = None;
    let out = h.second();
    assert_eq!(keyframe_width(&out), Some(96));
    assert_eq!(texts(&out)[1]["screen"]["kind"], "sign-in");
}

#[test]
fn follow_capture_failure_looks_again_instead_of_ending() {
    let mut h = harness(Mode::Watch, on_a());
    h.send(HELLO);
    h.second();
    h.second();
    // The X server restarted under the same session: reopened at once.
    let fresh = FakeScreen::new("A", 128);
    h.seat
        .lock()
        .unwrap()
        .screens
        .insert("a".into(), fresh.clone());
    h.a.broken.store(true, Ordering::SeqCst);
    h.send(r#"{"type":"keyframe"}"#);
    let out = h.tick_soon();
    assert!(h.session.ended().is_none());
    assert!(texts(&out).iter().all(|m| m["type"] != "state"), "{out:?}");
    assert_eq!(h.opened(), vec!["a", "a"]);
    assert_eq!(keyframe_width(&h.tick_soon()), Some(128));

    // Failing straight after opening: the reason shows, and the screen is
    // reopened by the next look, not at once.
    fresh.broken.store(true, Ordering::SeqCst);
    let out = h.tick_soon();
    assert_eq!(
        of_type(&texts(&out), "state")[0]["screen"],
        serde_json::json!({"kind": "unavailable", "reason": "The screen went away: the X server went away"})
    );
    assert!(h.tick_soon().is_empty());
    assert_eq!(h.opened().len(), 2);
    fresh.broken.store(false, Ordering::SeqCst);
    let out = h.second();
    assert_eq!(h.opened().len(), 3);
    assert_eq!(
        of_type(&texts(&out), "state")[0]["screen"]["kind"],
        "desktop"
    );
    assert_eq!(keyframe_width(&out), Some(128));
    assert!(h.session.ended().is_none());
}
