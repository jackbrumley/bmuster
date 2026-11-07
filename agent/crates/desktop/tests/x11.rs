//! X11 capture and input against a nested X server (SPEC-DESKTOP 11.2):
//! `x11_capture`, `x11_input` and `displays` tests, plus one session end to
//! end. Each test starts its own headless Xvfb (Xephyr only when asked for
//! with `BMUSTER_X_TESTS=xephyr`) and skips without one; see
//! `support/mod.rs`. Run them with `cargo test -p bmuster-desktop --test x11`.

#![cfg(target_os = "linux")]

mod support;

use bmuster_desktop::capture::x11::X11Capturer;
use bmuster_desktop::capture::x11_session::connect;
use bmuster_desktop::capture::{Capturer, Damage, DesktopKind, DesktopState, Rect};
use bmuster_desktop::encode::tiles::TileEncoder;
use bmuster_desktop::input::x11::XTestInput;
use bmuster_desktop::input::{InputBackend, InputController};
use bmuster_desktop::{DesktopSession, Mode, Outgoing};
use std::time::{Duration, Instant};
use support::NestedX;
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{
    ConnectionExt as _, CreateGCAux, CreateWindowAux, EventMask, InputFocus, KeyButMask, Rectangle,
    Window, WindowClass,
};
use x11rb::protocol::Event;
use x11rb::rust_connection::RustConnection;

fn state() -> DesktopState {
    DesktopState {
        desktop: DesktopKind::Default,
        locked: false,
        signed_in_user: None,
    }
}

/// The test's own X client on the nested server.
struct Client {
    connection: RustConnection,
    root: Window,
}

impl Client {
    fn new(x: &NestedX) -> Client {
        let (connection, screen) =
            connect(&x.target).expect("test client connects with the cookie");
        let root = connection.setup().roots[screen].root;
        Client { connection, root }
    }

    /// Waits until the server has handled everything sent so far.
    fn sync(&self) {
        self.connection.get_input_focus().unwrap().reply().unwrap();
    }

    fn fill_root(&self, rect: Rect, rgb: u32) {
        let gc = self.connection.generate_id().unwrap();
        self.connection
            .create_gc(
                gc,
                self.root,
                &CreateGCAux::new()
                    .foreground(rgb)
                    .subwindow_mode(x11rb::protocol::xproto::SubwindowMode::INCLUDE_INFERIORS),
            )
            .unwrap();
        self.connection
            .poly_fill_rectangle(
                self.root,
                gc,
                &[Rectangle {
                    x: rect.x as i16,
                    y: rect.y as i16,
                    width: rect.width as u16,
                    height: rect.height as u16,
                }],
            )
            .unwrap();
        self.connection.free_gc(gc).unwrap();
        self.sync();
    }

    /// A full-screen window that receives pointer and key events and has
    /// the keyboard focus, like a small `xev`.
    fn event_window(&self) -> Window {
        let window = self.connection.generate_id().unwrap();
        let events = EventMask::KEY_PRESS
            | EventMask::KEY_RELEASE
            | EventMask::BUTTON_PRESS
            | EventMask::BUTTON_RELEASE
            | EventMask::POINTER_MOTION
            | EventMask::STRUCTURE_NOTIFY;
        self.connection
            .create_window(
                x11rb::COPY_DEPTH_FROM_PARENT,
                window,
                self.root,
                0,
                0,
                1280,
                800,
                0,
                WindowClass::INPUT_OUTPUT,
                x11rb::COPY_FROM_PARENT,
                &CreateWindowAux::new()
                    .override_redirect(1)
                    .background_pixel(0x20_20_20)
                    .event_mask(events),
            )
            .unwrap();
        self.connection.map_window(window).unwrap();
        self.wait_for(Duration::from_secs(5), |e| matches!(e, Event::MapNotify(_)));
        self.connection
            .set_input_focus(InputFocus::POINTER_ROOT, window, x11rb::CURRENT_TIME)
            .unwrap();
        self.sync();
        window
    }

    /// Collects events until `done` matches one or the time runs out.
    fn wait_for(&self, timeout: Duration, done: impl Fn(&Event) -> bool) -> Vec<Event> {
        self.connection.flush().unwrap();
        let deadline = Instant::now() + timeout;
        let mut events = Vec::new();
        while Instant::now() < deadline {
            match self.connection.poll_for_event().unwrap() {
                Some(event) => {
                    let stop = done(&event);
                    events.push(event);
                    if stop {
                        return events;
                    }
                }
                None => std::thread::sleep(Duration::from_millis(5)),
            }
        }
        events
    }

    fn keysym(&self, keycode: u8, column: usize) -> u32 {
        let reply = self
            .connection
            .get_keyboard_mapping(keycode, 1)
            .unwrap()
            .reply()
            .unwrap();
        reply.keysyms[column]
    }

    fn pointer_mask(&self) -> KeyButMask {
        self.connection
            .query_pointer(self.root)
            .unwrap()
            .reply()
            .unwrap()
            .mask
    }
}

fn pixel(capturer: &X11Capturer, x: u32, y: u32) -> [u8; 3] {
    let row = capturer.frame().row(y);
    let p = &row[x as usize * 4..x as usize * 4 + 3];
    [p[2], p[1], p[0]]
}

fn controller(x: &NestedX) -> InputController {
    let backend: Box<dyn InputBackend> = Box::new(XTestInput::open(&x.target).unwrap());
    InputController::new(backend)
}

fn key_presses(events: &[Event]) -> Vec<(u8, u16)> {
    events
        .iter()
        .filter_map(|e| match e {
            Event::KeyPress(k) => Some((k.detail, u16::from(k.state))),
            _ => None,
        })
        .collect()
}

#[test]
fn x11_capture_reads_drawn_pixels_through_the_xauthority_cookie() {
    let Some(x) = NestedX::start() else { return };
    let client = Client::new(&x);
    client.fill_root(Rect::new(0, 0, 1280, 800), 0x00_00_00);
    client.fill_root(Rect::new(100, 50, 200, 100), 0xFF_00_00);
    client.fill_root(Rect::new(700, 400, 64, 64), 0x00_80_FF);

    let mut capturer = X11Capturer::open(&x.target, state()).unwrap();
    assert_eq!(capturer.displays().len(), 1);
    let display = &capturer.displays()[0];
    assert_eq!(
        (display.width, display.height, display.primary),
        (1280, 800, true)
    );

    assert_eq!(capturer.capture(true).unwrap(), Damage::Unknown);
    assert_eq!(pixel(&capturer, 150, 100), [0xFF, 0, 0]);
    assert_eq!(pixel(&capturer, 710, 410), [0, 0x80, 0xFF]);
    assert_eq!(pixel(&capturer, 5, 5), [0, 0, 0]);
}

#[test]
fn x11_capture_damage_yields_only_the_touching_tiles() {
    let Some(x) = NestedX::start() else { return };
    let client = Client::new(&x);
    client.fill_root(Rect::new(0, 0, 1280, 800), 0x10_10_10);
    let mut capturer = X11Capturer::open(&x.target, state()).unwrap();
    let mut encoder = TileEncoder::new();
    capturer.capture(true).unwrap();
    let key = encoder
        .encode(capturer.frame(), &Damage::Unknown, true, 70)
        .unwrap();
    assert_eq!(key.tiles.len(), 20 * 13);

    assert_eq!(capturer.capture(false).unwrap(), Damage::None);

    client.fill_root(Rect::new(60, 60, 10, 10), 0x00_FF_00);
    let damage = capturer.capture(false).unwrap();
    let Damage::Rects(rects) = &damage else {
        panic!("expected damage rectangles, got {damage:?}");
    };
    assert!(rects
        .iter()
        .any(|r| r.intersect(&Rect::new(60, 60, 10, 10)).is_some()));
    assert_eq!(pixel(&capturer, 65, 65), [0, 0xFF, 0]);
    let encoded = encoder
        .encode(capturer.frame(), &damage, false, 70)
        .unwrap();
    let mut tiles: Vec<(u16, u16)> = encoded.tiles.iter().map(|t| (t.x, t.y)).collect();
    tiles.sort();
    assert_eq!(tiles, vec![(0, 0), (0, 64), (64, 0), (64, 64)]);
    assert_eq!(capturer.capture(false).unwrap(), Damage::None);
}

#[test]
fn displays_randr_lists_the_nested_monitor() {
    let Some(x) = NestedX::start() else { return };
    let mut capturer = X11Capturer::open(&x.target, state()).unwrap();
    let displays = capturer.displays().to_vec();
    assert_eq!(displays.len(), 1);
    assert!(!displays[0].id.is_empty());
    assert_eq!((displays[0].x, displays[0].y), (0, 0));
    assert!(!capturer.poll_layout().unwrap(), "no layout change yet");
}

#[test]
fn x11_cursor_position_and_shape() {
    let Some(x) = NestedX::start() else { return };
    let mut capturer = X11Capturer::open(&x.target, state()).unwrap();
    let mut input = controller(&x);
    input
        .pointer(Rect::new(0, 0, 1280, 800), 300.0, 200.0, 0)
        .unwrap();
    let cursor = capturer.cursor().unwrap();
    assert_eq!((cursor.x, cursor.y), (300, 200));
    let image = capturer
        .cursor_image(cursor.id)
        .unwrap()
        .expect("cursor image");
    assert!(image.width > 0 && image.height > 0);
    assert_eq!(image.rgba.len(), (image.width * image.height * 4) as usize);
}

#[test]
fn x11_input_pointer_moves_and_clicks_arrive() {
    let Some(x) = NestedX::start() else { return };
    let client = Client::new(&x);
    client.event_window();
    let mut input = controller(&x);
    input
        .pointer(Rect::new(0, 0, 1280, 800), 400.0, 300.0, 0)
        .unwrap();
    input
        .pointer(Rect::new(0, 0, 1280, 800), 400.0, 300.0, 1)
        .unwrap();
    input
        .pointer(Rect::new(0, 0, 1280, 800), 400.0, 300.0, 0)
        .unwrap();
    let events = client.wait_for(Duration::from_secs(5), |e| {
        matches!(e, Event::ButtonRelease(_))
    });
    assert!(events
        .iter()
        .any(|e| matches!(e, Event::MotionNotify(m) if (m.root_x, m.root_y) == (400, 300))));
    assert!(events
        .iter()
        .any(|e| matches!(e, Event::ButtonPress(b) if b.detail == 1)));
    assert!(events
        .iter()
        .any(|e| matches!(e, Event::ButtonRelease(b) if b.detail == 1)));
    let pointer = client
        .connection
        .query_pointer(client.root)
        .unwrap()
        .reply()
        .unwrap();
    assert_eq!((pointer.root_x, pointer.root_y), (400, 300));
}

#[test]
fn x11_input_key_by_position_gives_the_keycode_for_a() {
    let Some(x) = NestedX::start() else { return };
    let client = Client::new(&x);
    client.event_window();
    let mut input = controller(&x);
    input.key("KeyA", "a", true, false).unwrap();
    input.key("KeyA", "a", false, false).unwrap();
    let events = client.wait_for(
        Duration::from_secs(5),
        |e| matches!(e, Event::KeyRelease(k) if k.detail != 38 && k.detail != 50),
    );
    let presses = key_presses(&events);
    assert_eq!(presses.len(), 1);
    assert_eq!(client.keysym(presses[0].0, 0), u32::from(b'a'));
}

#[test]
fn x11_input_alt_gr_q_on_a_german_layout_gives_at() {
    let Some(x) = NestedX::start() else { return };
    let output = x.run_client("setxkbmap", &["de"]);
    if !output.status.success() {
        eprintln!(
            "skipping AltGr test: setxkbmap de failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        return;
    }
    let client = Client::new(&x);
    client.event_window();
    // Opened after the layout change, so it reads the German map.
    let mut input = controller(&x);
    assert_eq!(
        client.keysym(24, 4),
        u32::from(b'@'),
        "German layout active"
    );
    input.key("AltRight", "AltGraph", true, true).unwrap();
    input.key("KeyQ", "@", true, false).unwrap();
    input.key("KeyQ", "@", false, false).unwrap();
    input.key("AltRight", "AltGraph", false, true).unwrap();
    let events = client.wait_for(
        Duration::from_secs(5),
        |e| matches!(e, Event::KeyRelease(k) if k.detail == 24),
    );
    let (keycode, modifiers) = *key_presses(&events)
        .iter()
        .find(|(keycode, _)| *keycode == 24)
        .expect("KeyQ arrived");
    // Level 3 (column 4 of the core map) of Q on a German layout is '@', and
    // the press carries the level-3 modifier (Mod5).
    assert_eq!(client.keysym(keycode, 4), u32::from(b'@'));
    assert_ne!(modifiers & u16::from(KeyButMask::MOD5), 0, "AltGr held");
}

#[test]
fn x11_input_text_types_mapped_and_unmapped_characters() {
    let Some(x) = NestedX::start() else { return };
    let client = Client::new(&x);
    client.event_window();
    let mut input = controller(&x);
    input.text("A").unwrap();
    let events = client.wait_for(
        Duration::from_secs(5),
        |e| matches!(e, Event::KeyRelease(k) if k.detail == 38),
    );
    let presses = key_presses(&events);
    // Shift, then the `a` key with Shift held.
    let (keycode, modifiers) = *presses.last().expect("a key press");
    assert_eq!(keycode, 38);
    assert_ne!(modifiers & u16::from(KeyButMask::SHIFT), 0);

    // The US map has no Euro sign: it goes through a borrowed key code.
    input.text("€").unwrap();
    let events = client.wait_for(
        Duration::from_secs(5),
        |e| matches!(e, Event::KeyRelease(k) if k.detail != 38 && k.detail != 50),
    );
    let (keycode, _) = *key_presses(&events).last().expect("euro key press");
    let keysym = client.keysym(keycode, 0);
    assert!(
        keysym == 0x20AC || keysym == 0x0100_20AC,
        "keysym {keysym:#x}"
    );

    // The borrowed key code is cleared when the injector goes.
    drop(input);
    client.sync();
    assert_eq!(client.keysym(keycode, 0), 0);
}

#[test]
fn x11_input_release_all_leaves_no_modifier_or_button_down() {
    let Some(x) = NestedX::start() else { return };
    let client = Client::new(&x);
    client.event_window();
    let mut input = controller(&x);
    for code in ["ShiftLeft", "ControlLeft", "AltLeft", "MetaLeft"] {
        input.key(code, "", true, false).unwrap();
    }
    input.key("AltRight", "AltGraph", true, true).unwrap();
    input
        .pointer(Rect::new(0, 0, 1280, 800), 10.0, 10.0, 1 | 4)
        .unwrap();
    client.sync();
    assert_ne!(
        u16::from(client.pointer_mask()),
        0,
        "keys and buttons are held"
    );

    input.release_all().unwrap();
    client.sync();
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(u16::from(client.pointer_mask()), 0);
}

#[test]
fn x11_session_end_to_end_frames_and_pointer() {
    let Some(x) = NestedX::start() else { return };
    let client = Client::new(&x);
    client.fill_root(Rect::new(0, 0, 1280, 800), 0x33_66_99);
    let capturer = X11Capturer::open(&x.target, state()).unwrap();
    let target = x.target.clone();
    let now = Instant::now();
    let mut session = DesktopSession::new(
        Mode::Control,
        Box::new(capturer),
        move || Ok(Box::new(XTestInput::open(&target)?) as Box<dyn InputBackend>),
        now,
    )
    .unwrap();
    let out = session.handle_text(
        r#"{"type":"hello","codecs":["jpeg"],"viewport":{"width":1280,"height":800,"pixelRatio":1}}"#,
        now,
    );
    assert_eq!(out.len(), 2);
    let out = session.tick(now);
    let frames: Vec<&Vec<u8>> = out
        .iter()
        .filter_map(|m| match m {
            Outgoing::Binary(b) if b[0] == 2 => Some(b),
            _ => None,
        })
        .collect();
    assert!(!frames.is_empty());
    // A one-colour screen is all solid tiles: 260 of 17 bytes plus headers.
    let total: usize = frames.iter().map(|b| b.len()).sum();
    assert_eq!(total, frames.len() * 22 + 260 * 17);

    session.handle_text(r#"{"type":"pointer","x":640,"y":400,"buttons":0}"#, now);
    let pointer = client
        .connection
        .query_pointer(client.root)
        .unwrap()
        .reply()
        .unwrap();
    assert_eq!((pointer.root_x, pointer.root_y), (640, 400));
}
