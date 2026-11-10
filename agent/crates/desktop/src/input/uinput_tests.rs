//! uinput: the keymap and characters, pointer mapping, release-all, and
//! that only a control session ever builds the devices. The end-to-end test
//! with the real `/dev/uinput` is ignored and run by hand.

use super::*;
use crate::capture::kms::capturer::fake::{display, FakeKms};
use crate::capture::kms::capturer::SharedSource;
use crate::capture::Rect;
use crate::control::Mode;
use crate::follow::{Look, ScreenWatch};
use crate::input::absolute::{axis, PointerMap};
use crate::input::InputController;
use crate::session::DesktopSession;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

#[derive(Default)]
struct Recording {
    frames: Mutex<Vec<(Device, Vec<Event>)>>,
}

impl Recording {
    fn take(&self) -> Vec<(Device, Vec<Event>)> {
        std::mem::take(&mut *self.frames.lock().unwrap())
    }
}

impl Sink for Recording {
    fn emit(&self, device: Device, events: &[Event]) -> io::Result<()> {
        self.frames.lock().unwrap().push((device, events.to_vec()));
        Ok(())
    }
}

fn backend(map: PointerMap) -> (Arc<Recording>, InputController) {
    let recording = Arc::new(Recording::default());
    let sink = recording.clone();
    let opener = Opener::with(move || Ok(sink.clone() as Arc<dyn Sink>));
    let backend = opener.backend(Arc::new(Mutex::new(map))).unwrap();
    (recording, InputController::new(backend))
}

fn keys(frames: &[(Device, Vec<Event>)]) -> Vec<(u16, i32)> {
    frames
        .iter()
        .flat_map(|(device, events)| {
            assert_eq!(*device, Device::Keyboard);
            events.iter().map(|&(kind, code, value)| {
                assert_eq!(kind, EV_KEY);
                (code, value)
            })
        })
        .collect()
}

#[test]
fn keymap_and_characters() {
    // Every key the browser can name by position (the X11 keymap's table)
    // is a code the keyboard device registers.
    for key in keymap::KEYS {
        assert!(
            (1..=LAST_KEY).contains(&key.evdev),
            "{} is evdev {}",
            key.code,
            key.evdev
        );
    }
    let (recording, mut input) = backend(PointerMap::identity(&[Rect::new(0, 0, 100, 100)]));
    input.key("KeyQ", "q", true, false).unwrap();
    input.key("KeyQ", "q", false, false).unwrap();
    input.key("AltRight", "AltGraph", true, true).unwrap();
    input.key("AltRight", "AltGraph", false, true).unwrap();
    assert_eq!(
        keys(&recording.take()),
        vec![(16, 1), (16, 0), (100, 1), (100, 0)]
    );

    // US characters: plain, shifted letters, shifted digits and symbols.
    assert_eq!(us_key('a').map(|(k, s)| (k.evdev, s)), Some((30, false)));
    assert_eq!(us_key('A').map(|(k, s)| (k.evdev, s)), Some((30, true)));
    assert_eq!(us_key('0').map(|(k, s)| (k.evdev, s)), Some((11, false)));
    assert_eq!(us_key('!').map(|(k, s)| (k.evdev, s)), Some((2, true)));
    assert_eq!(us_key('/').map(|(k, s)| (k.evdev, s)), Some((53, false)));
    assert_eq!(us_key('?').map(|(k, s)| (k.evdev, s)), Some((53, true)));
    assert_eq!(us_key('"').map(|(k, s)| (k.evdev, s)), Some((40, true)));
    assert_eq!(us_key(' ').map(|(k, s)| (k.evdev, s)), Some((57, false)));
    for character in (' '..='~').filter(|c| *c != ' ') {
        assert!(us_key(character).is_some(), "{character:?} has a US key");
    }
    assert!(us_key('€').is_none());
    assert!(us_key('é').is_none());

    input.text("Hi!\n").unwrap();
    assert_eq!(
        keys(&recording.take()),
        vec![
            (42, 1),
            (35, 1),
            (35, 0),
            (42, 0),
            (23, 1),
            (23, 0),
            (42, 1),
            (2, 1),
            (2, 0),
            (42, 0),
            (28, 1),
            (28, 0),
        ]
    );
    // Others are reported, and the rest of the text still goes.
    let error = input.text("a€b").unwrap_err();
    assert_eq!(error.0, CANNOT_TYPE);
    assert_eq!(
        keys(&recording.take()),
        vec![(30, 1), (30, 0), (48, 1), (48, 0)]
    );
}

#[test]
fn pointer_mapping_and_release() {
    // Two displays side by side: 1920 + 1280 wide, the taller 1200 high.
    let second = Rect::new(1920, 0, 1280, 800);
    let (recording, mut input) =
        backend(PointerMap::identity(&[Rect::new(0, 0, 1920, 1200), second]));
    input.pointer(second, 0.0, 0.0, 0).unwrap();
    input.pointer(second, 1279.0, 799.0, 1 | 4).unwrap();
    let frames = recording.take();
    // The middle of each pixel, over the whole stage.
    assert_eq!(
        frames[0],
        (
            Device::Pointer,
            vec![
                (EV_ABS, ABS_X, axis(1920.5, 3200.0)),
                (EV_ABS, ABS_Y, axis(0.5, 1200.0))
            ]
        )
    );
    assert_eq!(
        frames[1].1,
        vec![
            (EV_ABS, ABS_X, axis(3199.5, 3200.0)),
            (EV_ABS, ABS_Y, axis(799.5, 1200.0))
        ]
    );
    assert_eq!(frames[2].1, vec![(EV_KEY, BTN_LEFT, 1)]);
    assert_eq!(frames[3].1, vec![(EV_KEY, BTN_MIDDLE, 1)]);

    // The wheel: high resolution every time, a notch when 120 add up; down
    // in the browser is negative on evdev's vertical wheel.
    input
        .wheel(0.0, 50.0, crate::control::WheelMode::Pixel)
        .unwrap();
    input
        .wheel(0.0, 50.0, crate::control::WheelMode::Pixel)
        .unwrap();
    input
        .wheel(-3.0, 0.0, crate::control::WheelMode::Line)
        .unwrap();
    assert_eq!(
        recording
            .take()
            .into_iter()
            .map(|(_, e)| e)
            .collect::<Vec<_>>(),
        vec![
            vec![(EV_REL, REL_WHEEL_HI_RES, -60)],
            vec![(EV_REL, REL_WHEEL_HI_RES, -60), (EV_REL, REL_WHEEL, -1)],
            vec![(EV_REL, REL_HWHEEL_HI_RES, -120), (EV_REL, REL_HWHEEL, -1)],
        ]
    );

    // Release-all lets go of every key and button still held.
    input.key("ControlLeft", "Control", true, false).unwrap();
    input.key("AltLeft", "Alt", true, false).unwrap();
    recording.take();
    input.release_all().unwrap();
    assert_eq!(
        recording
            .take()
            .into_iter()
            .map(|(_, e)| e)
            .collect::<Vec<_>>(),
        vec![
            vec![(EV_KEY, 56, 0)],
            vec![(EV_KEY, 29, 0)],
            vec![(EV_KEY, BTN_LEFT, 0)],
            vec![(EV_KEY, BTN_MIDDLE, 0)],
        ]
    );
    assert!(!input.holds_anything());
    // Ctrl+Alt+Del and console switching go as real chords.
    input
        .special(crate::control::SpecialKey::CtrlAltDel)
        .unwrap();
    assert_eq!(
        keys(&recording.take()),
        vec![(29, 1), (56, 1), (111, 1), (111, 0), (56, 0), (29, 0)]
    );
    input.key("ControlLeft", "Control", true, false).unwrap();
    input.key("AltLeft", "Alt", true, false).unwrap();
    input.key("F3", "F3", true, false).unwrap();
    assert_eq!(keys(&recording.take()), vec![(29, 1), (56, 1), (61, 1)]);
    drop(input);
    assert_eq!(keys(&recording.take()), vec![(61, 0), (56, 0), (29, 0)]);
}

/// A KMS screen (as the watch opens it) with an opener that counts.
struct KmsSeat {
    source: SharedSource,
    opener: Opener,
}

impl ScreenWatch for KmsSeat {
    fn look(&mut self) -> Look {
        Look {
            dark: false,
            key: "kms:c1".into(),
            state: crate::capture::DesktopState::SignIn,
        }
    }
    fn open(&mut self) -> Result<crate::Platform, String> {
        crate::kms_platform(
            self.source.clone(),
            self.opener.clone(),
            Box::new(crate::capture::kms::mutter::NoLayout("a test".into())),
        )
    }
}

struct Counted {
    drops: Arc<AtomicU32>,
}

impl Drop for Counted {
    fn drop(&mut self) {
        self.drops.fetch_add(1, Ordering::SeqCst);
    }
}

impl Sink for Counted {
    fn emit(&self, _device: Device, _events: &[Event]) -> io::Result<()> {
        Ok(())
    }
}

#[test]
fn watch_never_opens_uinput() {
    let fake = FakeKms::default();
    fake.0.lock().unwrap().displays = vec![display("card0-eDP-1", 0, 64, 32)];
    let source: SharedSource = Arc::new(Mutex::new(Box::new(fake)));
    let opened = Arc::new(AtomicU32::new(0));
    let drops = Arc::new(AtomicU32::new(0));
    let shared: Arc<Shared<Counted>> = Arc::new(Shared::new());
    let opener = {
        let (opened, drops, shared) = (opened.clone(), drops.clone(), shared.clone());
        Opener::with(move || {
            let device = shared.acquire(|| {
                opened.fetch_add(1, Ordering::SeqCst);
                Ok::<_, InputError>(Counted {
                    drops: drops.clone(),
                })
            })?;
            Ok(device as Arc<dyn Sink>)
        })
    };
    // Following sessions move the notice bar, which is shared by every test.
    let _turn = crate::notice::test_turn();
    let hello = r#"{"type":"hello","codecs":["jpeg"],"viewport":{"width":800,"height":600,"pixelRatio":1}}"#;
    let session = |mode: Mode| {
        let now = Instant::now();
        let watch = KmsSeat {
            source: source.clone(),
            opener: opener.clone(),
        };
        let mut session = DesktopSession::following(mode, Box::new(watch), now);
        session.handle_text(hello, now);
        session.handle_text(r#"{"type":"pointer","x":3,"y":3,"buttons":1}"#, now);
        session.tick(now + Duration::from_millis(100));
        session
    };

    // Watch: the screen is shown, input is refused, the opener is never called.
    let watching = session(Mode::Watch);
    assert_eq!(opened.load(Ordering::SeqCst), 0, "watch never opens uinput");

    // Control: the devices are made once and shared by two sessions.
    let first = session(Mode::Control);
    let second = session(Mode::Control);
    assert_eq!(opened.load(Ordering::SeqCst), 1);
    drop(watching);
    drop(first);
    assert_eq!(drops.load(Ordering::SeqCst), 0, "still held by the second");
    drop(second);
    assert_eq!(
        drops.load(Ordering::SeqCst),
        1,
        "the last control session destroys them"
    );
    // A later control session makes them again.
    let third = session(Mode::Control);
    assert_eq!(opened.load(Ordering::SeqCst), 2);
    drop(third);
    assert_eq!(drops.load(Ordering::SeqCst), 2);
}

/// C10, run by hand on an X11 desktop where the user can write
/// `/dev/uinput` (an ACL or root): creates the real devices, opens a small
/// window on `BMUSTER_UINPUT_TEST_DISPLAY` (for example `:0`), and checks
/// that a pointer move and a Shift tap from uinput arrive in it. Nothing
/// is clicked and only Shift is pressed, so a window that lost focus is
/// never typed into; every key is released on the way out.
#[test]
#[ignore = "needs /dev/uinput write access and a real X11 display: BMUSTER_UINPUT_TEST_DISPLAY=:0"]
fn uinput_reaches_x11_window() {
    use x11rb::connection::Connection as _;
    use x11rb::protocol::xproto::{
        self, ConnectionExt as _, CreateWindowAux, EventMask, WindowClass,
    };
    use x11rb::protocol::Event as XEvent;

    let display =
        std::env::var("BMUSTER_UINPUT_TEST_DISPLAY").expect("set BMUSTER_UINPUT_TEST_DISPLAY");
    let (x, screen_index) = x11rb::connect(Some(&display)).expect("the X display opens");
    let screen = &x.setup().roots[screen_index];
    let (root_width, root_height) = (screen.width_in_pixels, screen.height_in_pixels);
    let window = x.generate_id().unwrap();
    // On a monitor: parts of a multi-monitor root are not on any screen,
    // and the X server keeps the pointer out of them.
    let monitor = x11rb::protocol::randr::ConnectionExt::randr_get_monitors(&x, screen.root, true)
        .unwrap()
        .reply()
        .unwrap()
        .monitors
        .into_iter()
        .next()
        .expect("a monitor");
    let (left, top, size) = (monitor.x + 100, monitor.y + 100, 300u16);
    x.create_window(
        x11rb::COPY_DEPTH_FROM_PARENT,
        window,
        screen.root,
        left,
        top,
        size,
        size,
        0,
        WindowClass::INPUT_OUTPUT,
        0,
        &CreateWindowAux::new()
            .background_pixel(screen.white_pixel)
            .override_redirect(1)
            .event_mask(
                EventMask::POINTER_MOTION
                    | EventMask::KEY_PRESS
                    | EventMask::KEY_RELEASE
                    | EventMask::ENTER_WINDOW,
            ),
    )
    .unwrap();
    x.map_window(window).unwrap();
    x.configure_window(
        window,
        &xproto::ConfigureWindowAux::new().stack_mode(xproto::StackMode::ABOVE),
    )
    .unwrap();
    x.flush().unwrap();
    std::thread::sleep(Duration::from_millis(300));

    let devices = Arc::new(Devices::create(Path::new(UINPUT)).expect("uinput devices"));
    // Give the X server time to add the new devices (udev, then libinput).
    std::thread::sleep(Duration::from_secs(2));
    let map = Arc::new(Mutex::new(PointerMap::identity(&[Rect::new(
        0,
        0,
        u32::from(root_width),
        u32::from(root_height),
    )])));
    let sink = devices.clone();
    let mut input = InputController::new(
        Opener::with(move || Ok(sink.clone() as Arc<dyn Sink>))
            .backend(map)
            .unwrap(),
    );
    let centre = Rect::new(0, 0, u32::from(root_width), u32::from(root_height));
    let target = (f64::from(left) + 150.0, f64::from(top) + 150.0);
    input
        .pointer(centre, target.0 - 20.0, target.1 - 20.0, 0)
        .unwrap();
    input.pointer(centre, target.0, target.1, 0).unwrap();
    std::thread::sleep(Duration::from_millis(300));
    x.set_input_focus(
        xproto::InputFocus::POINTER_ROOT,
        window,
        x11rb::CURRENT_TIME,
    )
    .unwrap();
    x.flush().unwrap();
    std::thread::sleep(Duration::from_millis(200));
    let focused = x.get_input_focus().unwrap().reply().unwrap().focus;
    let shift_sent = focused == window;
    if shift_sent {
        input.key("ShiftLeft", "Shift", true, false).unwrap();
        input.key("ShiftLeft", "Shift", false, false).unwrap();
    }
    input.release_all().unwrap();
    std::thread::sleep(Duration::from_millis(300));

    let (mut moved, mut pressed) = (None, false);
    while let Some(event) = x.poll_for_event().unwrap() {
        match event {
            XEvent::MotionNotify(motion) => moved = Some((motion.root_x, motion.root_y)),
            XEvent::EnterNotify(enter) => moved = moved.or(Some((enter.root_x, enter.root_y))),
            XEvent::KeyPress(_) => pressed = true,
            _ => {}
        }
    }
    drop(input);
    drop(devices);
    x.destroy_window(window).unwrap();
    x.flush().unwrap();
    let (mx, my) = moved.expect("the pointer reached the test window");
    assert!(
        (i32::from(mx) - target.0 as i32).abs() <= 2
            && (i32::from(my) - target.1 as i32).abs() <= 2,
        "pointer at {mx},{my}, wanted {target:?}"
    );
    assert!(shift_sent, "the test window could not take the focus");
    assert!(pressed, "Shift reached the test window");
}

/// SPEC-DESKTOP-WAKE W6.
#[test]
fn wake_device_capabilities_and_events() {
    use crate::follow::Waker;
    use wake::{UinputWaker, WakeSink, NUDGE, WAKE_AXES, WAKE_BUTTONS, WAKE_EVENT_TYPES};

    // A relative pointer libinput accepts, and nothing that types or jumps.
    assert_eq!(WAKE_EVENT_TYPES, [EV_KEY, EV_REL]);
    assert_eq!(WAKE_BUTTONS, [BTN_LEFT]);
    assert_eq!(WAKE_AXES, [0, 1], "REL_X and REL_Y");
    assert!(!WAKE_EVENT_TYPES.contains(&EV_ABS));

    #[derive(Default)]
    struct Frames(Mutex<Vec<Vec<Event>>>);
    impl WakeSink for Frames {
        fn emit(&self, events: &[Event]) -> io::Result<()> {
            self.0.lock().unwrap().push(events.to_vec());
            Ok(())
        }
    }
    let frames = Arc::new(Frames::default());
    let mut waker = UinputWaker::new(frames.clone());
    waker.nudge().unwrap();
    waker.nudge().unwrap();
    let written = std::mem::take(&mut *frames.0.lock().unwrap());
    let one = [vec![(EV_REL, 0, 1)], vec![(EV_REL, 0, -1)]];
    assert_eq!(written[..2], one[..], "one unit right, then back");
    assert_eq!(written[2..], one[..]);
    assert_eq!(
        NUDGE.iter().map(|e| e.2).sum::<i32>(),
        0,
        "ends where it began"
    );
    for (kind, code, _) in written.iter().flatten() {
        assert!(
            WAKE_EVENT_TYPES.contains(kind) && WAKE_AXES.contains(code),
            "only the axes it registers"
        );
    }
}
