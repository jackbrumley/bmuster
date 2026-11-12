use super::*;
use crate::capture::{
    CaptureResult, CursorImage, CursorState, Damage, DesktopState, DisplayInfo, Frame, Rect,
};
use crate::frame::{FLAG_KEYFRAME, FLAG_LAST_PART, HEADER_LEN};
use crate::input::recording::{Call, Recorder};
use crate::input::Button;
use std::sync::{Arc, Mutex};

/// What the test changes on the fake screen between ticks.
#[derive(Default)]
struct Screen {
    paint: Vec<(Rect, [u8; 4])>,
    cursor: Option<CursorState>,
    layout_changed: bool,
}

struct FakeCapturer {
    displays: Vec<DisplayInfo>,
    view: View,
    frame: Frame,
    screen: Arc<Mutex<Screen>>,
    full_captures: Arc<Mutex<u32>>,
}

fn display(id: &str, x: i32, width: u32, height: u32) -> DisplayInfo {
    DisplayInfo {
        id: id.to_string(),
        name: id.to_string(),
        x,
        y: 0,
        width,
        height,
        scale: 1.0,
        primary: x == 0,
    }
}

impl Capturer for FakeCapturer {
    fn displays(&self) -> &[DisplayInfo] {
        &self.displays
    }
    fn view(&self) -> View {
        self.view
    }
    fn can_show_all(&self) -> bool {
        crate::capture::combined::Combined::possible(&self.displays)
    }
    fn select(&mut self, view: View) -> CaptureResult<()> {
        self.view = view;
        let rect = crate::capture::shown_rect(&self.displays, view).unwrap();
        self.frame = Frame::new(rect.width, rect.height);
        Ok(())
    }
    fn poll_layout(&mut self) -> CaptureResult<bool> {
        Ok(std::mem::take(
            &mut self.screen.lock().unwrap().layout_changed,
        ))
    }
    fn capture(&mut self, full: bool) -> CaptureResult<Damage> {
        if full {
            *self.full_captures.lock().unwrap() += 1;
        }
        let paint = std::mem::take(&mut self.screen.lock().unwrap().paint);
        if paint.is_empty() && !full {
            return Ok(Damage::None);
        }
        for (rect, colour) in &paint {
            self.frame.fill(*rect, *colour);
        }
        Ok(Damage::Rects(paint.iter().map(|(r, _)| *r).collect()))
    }
    fn frame(&self) -> &Frame {
        &self.frame
    }
    fn cursor(&mut self) -> CaptureResult<CursorState> {
        Ok(self
            .screen
            .lock()
            .unwrap()
            .cursor
            .clone()
            .unwrap_or(CursorState {
                id: 1,
                x: -100,
                y: -100,
                visible: false,
            }))
    }
    fn cursor_image(&mut self, _id: u32) -> CaptureResult<Option<CursorImage>> {
        Ok(Some(CursorImage {
            width: 2,
            height: 2,
            hotspot_x: 1,
            hotspot_y: 0,
            rgba: vec![255; 16],
        }))
    }
    fn state(&self) -> DesktopState {
        DesktopState::Desktop {
            user: Some("jack".to_string()),
        }
    }

    fn backend(&self) -> &'static str {
        "test"
    }
}

struct Harness {
    session: DesktopSession,
    screen: Arc<Mutex<Screen>>,
    full_captures: Arc<Mutex<u32>>,
    recorder: Recorder,
    now: Instant,
}

const HELLO: &str =
    r#"{"type":"hello","codecs":["jpeg"],"viewport":{"width":4000,"height":4000,"pixelRatio":1}}"#;

fn harness(mode: Mode) -> Harness {
    harness_with(
        mode,
        vec![display("A", 0, 128, 64), display("B", 128, 64, 64)],
    )
}

fn harness_with(mode: Mode, displays: Vec<DisplayInfo>) -> Harness {
    let screen = Arc::new(Mutex::new(Screen::default()));
    let full_captures = Arc::new(Mutex::new(0));
    let first = displays[0].rect();
    let capturer = FakeCapturer {
        displays,
        view: View::Display(0),
        frame: Frame::new(first.width, first.height),
        screen: screen.clone(),
        full_captures: full_captures.clone(),
    };
    let recorder = Recorder::default();
    let backend = recorder.clone();
    let now = Instant::now();
    let session = DesktopSession::new(
        mode,
        Box::new(capturer),
        move || -> InputResult<Box<dyn InputBackend>> {
            assert_eq!(mode, Mode::Control, "watch-only built an injector");
            Ok(Box::new(backend))
        },
        now,
    )
    .unwrap();
    Harness {
        session,
        screen,
        full_captures,
        recorder,
        now,
    }
}

impl Harness {
    fn send(&mut self, text: &str) -> Vec<Outgoing> {
        self.session.handle_text(text, self.now)
    }

    fn tick(&mut self) -> Vec<Outgoing> {
        self.now = self.session.next_tick(self.now).max(self.now);
        self.session.tick(self.now)
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

fn types(out: &[Outgoing]) -> Vec<String> {
    out.iter()
        .map(|m| match m {
            Outgoing::Text(t) => serde_json::from_str::<serde_json::Value>(t).unwrap()["type"]
                .as_str()
                .unwrap()
                .to_string(),
            Outgoing::Binary(b) => format!("bin{}", b[0]),
        })
        .collect()
}

fn frames(out: &[Outgoing]) -> Vec<&Vec<u8>> {
    out.iter()
        .filter_map(|m| match m {
            Outgoing::Binary(b) if b[0] == 2 => Some(b),
            _ => None,
        })
        .collect()
}

fn seq_of(batch: &[u8]) -> u32 {
    u32::from_le_bytes([batch[4], batch[5], batch[6], batch[7]])
}

#[test]
fn session_hello_sends_displays_and_state_then_a_keyframe_with_stream() {
    let mut h = harness(Mode::Watch);
    assert!(h.tick().is_empty(), "nothing is captured before hello");
    let out = h.send(HELLO);
    let messages = texts(&out);
    assert_eq!(messages[0]["type"], "displays");
    assert_eq!(messages[0]["current"], "A");
    assert_eq!(messages[0]["list"][1]["x"], 128);
    assert_eq!(messages[1]["type"], "state");
    assert_eq!(messages[1]["screen"]["user"], "jack");

    let out = h.tick();
    assert_eq!(types(&out)[..2], ["stream", "bin2"]);
    let stream = &texts(&out)[0];
    assert_eq!(
        (
            stream["codec"].as_str(),
            stream["width"].as_u64(),
            stream["display"].as_str()
        ),
        (Some("jpeg"), Some(128), Some("A"))
    );
    let batch = frames(&out)[0];
    assert_eq!(batch[2], FLAG_KEYFRAME | FLAG_LAST_PART);
    assert_eq!(seq_of(batch), 1);
    // Two black 64x64 tiles.
    assert_eq!(
        u16::from_le_bytes([batch[HEADER_LEN], batch[HEADER_LEN + 1]]),
        2
    );
}

#[test]
fn session_unchanged_screen_sends_nothing_and_changes_send_only_their_tiles() {
    let mut h = harness(Mode::Watch);
    h.send(HELLO);
    h.tick();
    h.send(r#"{"type":"ack","seq":1}"#);
    assert!(frames(&h.tick()).is_empty());

    h.screen
        .lock()
        .unwrap()
        .paint
        .push((Rect::new(70, 10, 5, 5), [0, 0, 255, 0]));
    let out = h.tick();
    let batch = frames(&out)[0];
    assert_eq!(seq_of(batch), 2);
    assert_eq!(batch[2], FLAG_LAST_PART);
    assert_eq!(
        u16::from_le_bytes([batch[HEADER_LEN], batch[HEADER_LEN + 1]]),
        1
    );
    // The tile at x 64.
    assert_eq!(&batch[HEADER_LEN + 2..HEADER_LEN + 4], &64u16.to_le_bytes());
}

#[test]
fn session_window_full_skips_capture_and_ack_resumes() {
    let mut h = harness(Mode::Watch);
    h.send(HELLO);
    let paint = |h: &Harness, x: i32| {
        h.screen
            .lock()
            .unwrap()
            .paint
            .push((Rect::new(x, 0, 4, 4), [x as u8, 9, 9, 0]));
    };
    assert_eq!(frames(&h.tick()).len(), 1);
    paint(&h, 1);
    assert_eq!(frames(&h.tick()).len(), 1);
    paint(&h, 2);
    // Two frames in flight: the change waits, nothing is captured.
    assert!(frames(&h.tick()).is_empty());
    assert!(frames(&h.tick()).is_empty());
    h.send(r#"{"type":"ack","seq":2}"#);
    let out = h.tick();
    assert_eq!(seq_of(frames(&out)[0]), 3);
}

#[test]
fn session_keyframe_request_gives_a_full_frame() {
    let mut h = harness(Mode::Watch);
    h.send(HELLO);
    h.tick();
    h.send(r#"{"type":"ack","seq":1}"#);
    h.send(r#"{"type":"keyframe"}"#);
    let before = *h.full_captures.lock().unwrap();
    let out = h.tick();
    let batch = frames(&out)[0];
    assert_eq!(batch[2] & FLAG_KEYFRAME, FLAG_KEYFRAME);
    assert_eq!(*h.full_captures.lock().unwrap(), before + 1);
}

#[test]
fn permissions_watch_only_drops_control_messages_and_never_builds_an_injector() {
    let mut h = harness(Mode::Watch);
    h.send(HELLO);
    let first = h.send(r#"{"type":"pointer","x":1,"y":1,"buttons":1}"#);
    assert_eq!(texts(&first)[0]["code"], "not-allowed");
    for text in [
        r#"{"type":"key","code":"KeyA","key":"a","down":true,"altGr":false}"#,
        r#"{"type":"text","text":"x"}"#,
        r#"{"type":"release-all"}"#,
        r#"{"type":"clipboard-pull"}"#,
    ] {
        assert!(h.send(text).is_empty(), "{text}");
    }
    assert!(h.recorder.take().is_empty());
}

#[test]
fn session_control_input_goes_to_the_selected_display() {
    let mut h = harness(Mode::Control);
    h.send(HELLO);
    h.send(r#"{"type":"pointer","x":10,"y":5,"buttons":1}"#);
    h.send(r#"{"type":"key","code":"ShiftLeft","key":"Shift","down":true,"altGr":false}"#);
    assert_eq!(
        h.recorder.take(),
        vec![
            Call::Move(10, 5),
            Call::Button(Button::Left, true),
            Call::Key("ShiftLeft", true)
        ]
    );

    // Switching display releases what is held, then lists the displays.
    let out = h.send(r#"{"type":"select-display","display":"B"}"#);
    assert_eq!(texts(&out)[0]["current"], "B");
    assert_eq!(
        h.recorder.take(),
        vec![
            Call::Key("ShiftLeft", false),
            Call::Button(Button::Left, false)
        ]
    );
    h.send(r#"{"type":"pointer","x":1000,"y":3,"buttons":0}"#);
    assert_eq!(h.recorder.take(), vec![Call::Move(128 + 63, 3)]);

    let out = h.tick();
    let stream = &texts(&out)[0];
    assert_eq!(
        (stream["display"].as_str(), stream["width"].as_u64()),
        (Some("B"), Some(64))
    );
    assert_eq!(frames(&out)[0][1], 1, "header display index");
}

#[test]
fn session_end_releases_held_keys_and_says_ended() {
    let mut h = harness(Mode::Control);
    h.send(HELLO);
    h.send(r#"{"type":"key","code":"ControlLeft","key":"Control","down":true,"altGr":false}"#);
    h.recorder.take();
    let out = h.session.end(EndReason::DisconnectedAtMachine);
    assert_eq!(texts(&out)[0]["reason"], "disconnected-at-machine");
    assert_eq!(h.recorder.take(), vec![Call::Key("ControlLeft", false)]);
    assert!(h.session.end(EndReason::Closed).is_empty());
    assert!(h.tick().is_empty());
}

#[test]
fn session_bad_messages_before_hello_and_twenty_end_it() {
    let mut h = harness(Mode::Control);
    let out = h.send(r#"{"type":"keyframe"}"#);
    assert_eq!(texts(&out)[0]["code"], "bad-message");
    assert!(h.send(r#"{"type":"something-new"}"#).is_empty());
    for _ in 0..18 {
        h.send("{");
    }
    assert_eq!(h.session.ended(), None);
    let out = h.send("{");
    assert_eq!(types(&out), ["error", "ended"]);
    assert_eq!(h.session.ended(), Some(EndReason::Closed));
}

#[test]
fn session_hello_without_jpeg_is_refused() {
    let mut h = harness(Mode::Watch);
    let out = h.send(
        r#"{"type":"hello","codecs":["h264"],"viewport":{"width":1,"height":1,"pixelRatio":1}}"#,
    );
    assert_eq!(texts(&out)[0]["code"], "encoder-failed");
    assert_eq!(h.session.ended(), Some(EndReason::Closed));
}

#[test]
fn session_cursor_shape_once_then_positions_in_frame_pixels() {
    let mut h = harness(Mode::Watch);
    h.send(HELLO);
    h.screen.lock().unwrap().cursor = Some(CursorState {
        id: 7,
        x: 20,
        y: 30,
        visible: true,
    });
    let out = h.tick();
    assert_eq!(types(&out), ["stream", "bin2", "bin3", "bin4"]);
    h.send(r#"{"type":"ack","seq":1}"#);
    assert!(h.tick().is_empty(), "unchanged cursor sends nothing");
    h.screen.lock().unwrap().cursor = Some(CursorState {
        id: 7,
        x: 21,
        y: 30,
        visible: true,
    });
    let out = h.tick();
    assert_eq!(types(&out), ["bin4"]);
    let Outgoing::Binary(position) = &out[0] else {
        unreachable!()
    };
    assert_eq!(&position[HEADER_LEN..HEADER_LEN + 4], &7u32.to_le_bytes());
    assert_eq!(
        &position[HEADER_LEN + 4..HEADER_LEN + 8],
        &21i32.to_le_bytes()
    );
}

#[test]
fn session_scale_halves_the_stream_and_cursor() {
    let mut h = harness(Mode::Watch);
    h.send(HELLO);
    h.send(r#"{"type":"settings","quality":"medium","scale":0.5,"maxFps":30}"#);
    h.screen.lock().unwrap().cursor = Some(CursorState {
        id: 1,
        x: 20,
        y: 30,
        visible: true,
    });
    let out = h.tick();
    let stream = &texts(&out)[0];
    assert_eq!(
        (stream["width"].as_u64(), stream["scale"].as_f64()),
        (Some(64), Some(0.5))
    );
    let Some(Outgoing::Binary(position)) = out.last() else {
        unreachable!()
    };
    assert_eq!(
        &position[HEADER_LEN + 4..HEADER_LEN + 8],
        &10i32.to_le_bytes()
    );
}

/// A KMS screen that is not changing reports no damage. Switching to a
/// smaller scale then sent a black keyframe (Fedora, 2026-11-11): the new
/// scaled frame must be drawn from the screen whatever the damage says.
#[test]
fn session_scale_change_on_a_still_screen_sends_the_screen_not_black() {
    let mut h = harness(Mode::Watch);
    h.send(HELLO);
    // BGRX green-ish; solid tiles carry it as RGBA (30, 200, 10, 255).
    h.screen.lock().unwrap().paint = vec![(Rect::new(0, 0, 128, 64), [10, 200, 30, 0])];
    h.tick();
    h.send(r#"{"type":"ack","seq":1}"#);
    // Nothing changes on the screen from here on.
    for scale in ["0.5", "0.25", "0.75"] {
        h.send(&format!(
            r#"{{"type":"settings","quality":"medium","scale":{scale},"maxFps":30}}"#
        ));
        let out = h.tick();
        let keyframe = frames(&out);
        assert!(!keyframe.is_empty(), "scale {scale}: a keyframe");
        assert_eq!(
            keyframe[0][2] & FLAG_KEYFRAME,
            FLAG_KEYFRAME,
            "scale {scale}"
        );
        let shows_screen = keyframe
            .iter()
            .any(|batch| batch.windows(4).any(|w| w == [30, 200, 10, 255]));
        assert!(
            shows_screen,
            "scale {scale}: the keyframe shows the screen, not black"
        );
        h.send(&format!(r#"{{"type":"ack","seq":{}}}"#, u32::MAX / 2));
    }
}

/// Q1 (SPEC-DESKTOP 20): a quality chosen mid-stream, with nothing changing
/// on the screen, is on every tile of the very next frame.
#[test]
fn session_quality_change_mid_stream_resends_every_tile_at_the_new_quality() {
    let mut h = harness(Mode::Watch);
    h.send(HELLO);
    // A pattern, so the tiles go as JPEG rather than one colour.
    h.screen.lock().unwrap().paint = (0..128)
        .step_by(4)
        .flat_map(|x| {
            (0..64).step_by(4).map(move |y| {
                let shade = ((x * 7 + y * 13) % 256) as u8;
                (Rect::new(x, y, 4, 4), [shade, 255 - shade, shade / 2, 0])
            })
        })
        .collect();
    let out = h.send(r#"{"type":"settings","quality":"low","scale":1,"maxFps":30}"#);
    assert!(texts(&out).is_empty(), "a fixed quality says no Auto level");
    let low: usize = frames(&h.tick()).iter().map(|b| b.len()).sum();
    h.send(r#"{"type":"ack","seq":1}"#);
    assert!(frames(&h.tick()).is_empty(), "a still screen sends nothing");

    let out = h.send(r#"{"type":"settings","quality":"extra-high","scale":1,"maxFps":30}"#);
    assert!(out.is_empty());
    let out = h.tick();
    let keyframe = frames(&out);
    assert_eq!(keyframe[0][2] & FLAG_KEYFRAME, FLAG_KEYFRAME);
    let extra_high: usize = keyframe.iter().map(|b| b.len()).sum();
    assert!(
        extra_high > low * 2,
        "every tile again, at the new quality ({low} then {extra_high} bytes)"
    );

    // Auto says where it starts: where the viewer asked.
    h.send(r#"{"type":"ack","seq":2}"#);
    let out = h.send(
        r#"{"type":"settings","quality":"auto","scale":1,"maxFps":30,"autoStart":"extra-high"}"#,
    );
    assert_eq!(
        texts(&out),
        [serde_json::json!({"type": "auto-quality", "level": "extra-high"})]
    );
}

#[test]
fn session_layout_change_resends_displays_and_a_keyframe() {
    let mut h = harness(Mode::Watch);
    h.send(HELLO);
    h.tick();
    h.send(r#"{"type":"ack","seq":1}"#);
    h.screen.lock().unwrap().layout_changed = true;
    let out = h.tick();
    // Same display and size: no `stream`, but a keyframe.
    assert_eq!(types(&out)[..2], ["displays", "bin2"]);
    assert_eq!(frames(&out)[0][2] & FLAG_KEYFRAME, FLAG_KEYFRAME);
}

#[test]
fn session_slots_allow_four() {
    let slots: Vec<_> = (0..MAX_SESSIONS)
        .map(|_| SessionSlot::try_acquire().unwrap())
        .collect();
    assert!(SessionSlot::try_acquire().is_none());
    drop(slots);
    assert!(SessionSlot::try_acquire().is_some());
}

#[test]
fn session_run_loop_answers_and_ends_when_the_socket_goes() {
    let h = harness(Mode::Watch);
    let mut session = h.session;
    let (sender, receiver) = std::sync::mpsc::channel();
    sender.send(Incoming::Text(HELLO.to_string())).unwrap();
    sender.send(Incoming::End(EndReason::NoBrowser)).unwrap();
    let mut sent = Vec::new();
    let stop = std::sync::atomic::AtomicBool::new(false);
    let reason = run(
        &mut session,
        &receiver,
        &mut |m| {
            sent.push(m);
            Ok(())
        },
        &stop,
        FIGURES_EVERY,
        &mut |_| {},
    );
    assert_eq!(reason, EndReason::NoBrowser);
    assert_eq!(types(&sent).first().map(String::as_str), Some("displays"));
    assert_eq!(types(&sent).last().map(String::as_str), Some("ended"));
}

#[test]
fn session_run_loop_stops_when_the_agent_stops() {
    let h = harness(Mode::Control);
    let mut session = h.session;
    let (_sender, receiver) = std::sync::mpsc::channel();
    let stop = std::sync::atomic::AtomicBool::new(true);
    let mut sent = Vec::new();
    let reason = run(
        &mut session,
        &receiver,
        &mut |m| {
            sent.push(m);
            Ok(())
        },
        &stop,
        FIGURES_EVERY,
        &mut |_| {},
    );
    assert_eq!(reason, EndReason::AgentLost);
    assert_eq!(types(&sent), ["ended"]);
}

/// SPEC-DESKTOP-ALL-SCREENS A2, A6.
#[test]
fn session_all_screens_shows_every_display_in_one_frame() {
    let mut h = harness(Mode::Control);
    let out = h.send(HELLO);
    assert_eq!(texts(&out)[0]["allScreens"], true);
    h.send(r#"{"type":"key","code":"ShiftLeft","key":"Shift","down":true,"altGr":false}"#);
    h.recorder.take();

    // Choosing all screens lets go of held keys, then lists the displays.
    let out = h.send(r#"{"type":"select-display","display":"all"}"#);
    let displays = &texts(&out)[0];
    assert_eq!(
        (displays["type"].as_str(), displays["current"].as_str()),
        (Some("displays"), Some("all"))
    );
    assert_eq!(h.recorder.take(), vec![Call::Key("ShiftLeft", false)]);

    // Pointer positions are in the combined frame: the edge pixels on either
    // side of the seam go to their own display, and the far corner clamps.
    for (x, expected) in [(127, 127), (128, 128), (5000, 128 + 63)] {
        h.send(&format!(
            r#"{{"type":"pointer","x":{x},"y":3,"buttons":0}}"#
        ));
        assert_eq!(h.recorder.take(), vec![Call::Move(expected, 3)]);
    }

    h.screen.lock().unwrap().cursor = Some(CursorState {
        id: 3,
        x: 150,
        y: 20,
        visible: true,
    });
    let out = h.tick();
    let stream = &texts(&out)[0];
    assert_eq!(
        (stream["display"].as_str(), stream["width"].as_u64()),
        (Some("all"), Some(192))
    );
    assert_eq!(
        frames(&out)[0][1],
        255,
        "header display byte for all screens"
    );
    // The cursor on B, at its place in the combined frame.
    let Some(Outgoing::Binary(position)) = out.last() else {
        unreachable!()
    };
    assert_eq!(
        &position[HEADER_LEN + 4..HEADER_LEN + 8],
        &150i32.to_le_bytes()
    );

    // And back to one display.
    let out = h.send(r#"{"type":"select-display","display":"B"}"#);
    assert_eq!(texts(&out)[0]["current"], "B");
    h.send(r#"{"type":"pointer","x":0,"y":0,"buttons":0}"#);
    assert_eq!(h.recorder.take(), vec![Call::Move(128, 0)]);
}

/// SPEC-DESKTOP-ALL-SCREENS A2: one display has nothing to combine.
#[test]
fn session_all_screens_needs_two_displays() {
    let mut h = harness_with(Mode::Watch, vec![display("A", 0, 128, 64)]);
    let out = h.send(HELLO);
    assert_eq!(texts(&out)[0]["allScreens"], false);
    let out = h.send(r#"{"type":"select-display","display":"all"}"#);
    let error = &texts(&out)[0];
    assert_eq!(
        (error["type"].as_str(), error["code"].as_str()),
        (Some("error"), Some("bad-message"))
    );
    let out = h.tick();
    assert_eq!(texts(&out)[0]["display"], "A");
}
