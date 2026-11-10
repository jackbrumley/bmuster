use super::super::layout::{LayoutMode, LogicalMonitor, MutterMonitor, MutterState};
use super::super::mutter::NoLayout;
use super::super::KmsCursor;
use super::fake::{display, FakeKms};
use super::*;
use crate::capture::Rect;
use crate::input::absolute::Mapped;

/// Mutter as the tests set it, counting the calls.
#[derive(Clone)]
struct FakeMutter {
    state: Arc<Mutex<Result<MutterState, String>>>,
    calls: Arc<Mutex<u32>>,
}

impl FakeMutter {
    fn new(state: Result<MutterState, String>) -> Self {
        FakeMutter {
            state: Arc::new(Mutex::new(state)),
            calls: Arc::new(Mutex::new(0)),
        }
    }
}

impl LayoutReader for FakeMutter {
    fn read(&mut self) -> Result<MutterState, String> {
        *self.calls.lock().unwrap() += 1;
        self.state.lock().unwrap().clone()
    }
}

/// `a` (100x50) on top, `b` (200x80) below it and 50 to the right.
fn stacked() -> MutterState {
    MutterState {
        mode: LayoutMode::Logical,
        monitors: vec![
            MutterMonitor {
                connector: "a".into(),
                mode: Some((100, 50)),
            },
            MutterMonitor {
                connector: "b".into(),
                mode: Some((200, 80)),
            },
        ],
        logical: vec![
            LogicalMonitor {
                x: 0,
                y: 0,
                scale: 1.0,
                transform: 0,
                primary: false,
                connectors: vec!["a".into()],
            },
            LogicalMonitor {
                x: 50,
                y: 50,
                scale: 1.0,
                transform: 0,
                primary: true,
                connectors: vec!["b".into()],
            },
        ],
    }
}

fn capturer(fake: &FakeKms, reader: Box<dyn LayoutReader>) -> (KmsCapturer, SharedPointerMap) {
    let source: SharedSource = Arc::new(Mutex::new(Box::new(fake.clone())));
    let pointer = unset_pointer();
    let capturer = KmsCapturer::new(source, pointer.clone(), reader).unwrap();
    (capturer, pointer)
}

fn two_side_by_side() -> FakeKms {
    let fake = FakeKms::default();
    {
        let mut screens = fake.0.lock().unwrap();
        screens.displays = vec![display("a", 0, 100, 50), display("b", 100, 200, 80)];
        screens.colours = vec![("a".into(), [1, 1, 1, 0]), ("b".into(), [2, 2, 2, 0])];
    }
    fake
}

fn pixel(frame: &Frame, x: u32, y: u32) -> [u8; 4] {
    let at = x as usize * 4;
    frame.row(y)[at..at + 4].try_into().unwrap()
}

#[test]
fn kms_capturer_keeps_its_display_and_maps_the_pointer() {
    let fake = two_side_by_side();
    let (mut capturer, pointer) = capturer(&fake, Box::new(NoLayout("greeter".into())));
    assert_eq!(
        *pointer.lock().unwrap(),
        PointerMap::identity(&[Rect::new(0, 0, 100, 50), Rect::new(100, 0, 200, 80)])
    );
    capturer.select(View::Display(1)).unwrap();
    assert_eq!(capturer.capture(false).unwrap(), Damage::Unknown);
    assert_eq!(capturer.frame().width, 200);
    // Display a goes away; b stays current, at a new position.
    fake.0.lock().unwrap().displays = vec![display("b", 0, 200, 80)];
    capturer.next_layout = Instant::now();
    assert!(capturer.poll_layout().unwrap());
    assert_eq!(
        (capturer.view(), capturer.displays()[0].x),
        (View::Display(0), 0)
    );
    assert_eq!(
        *pointer.lock().unwrap(),
        PointerMap::identity(&[Rect::new(0, 0, 200, 80)])
    );
    assert!(!capturer.can_show_all());
    // Everything off: an error, so the session looks again.
    fake.0.lock().unwrap().displays.clear();
    capturer.next_layout = Instant::now();
    assert_eq!(capturer.poll_layout().unwrap_err().0, SCREEN_OFF);
}

#[test]
fn kms_all_screens_composes_the_displays_side_by_side_when_mutter_cannot_say() {
    let fake = two_side_by_side();
    let (mut capturer, _) = capturer(&fake, Box::new(NoLayout("greeter".into())));
    assert!(capturer.can_show_all());
    capturer.select(View::All).unwrap();
    assert_eq!(capturer.view(), View::All);
    assert_eq!(
        capturer.capture(false).unwrap(),
        Damage::Rects(vec![Rect::new(0, 0, 100, 50), Rect::new(100, 0, 200, 80)])
    );
    let frame = capturer.frame();
    assert_eq!((frame.width, frame.height), (300, 80));
    assert_eq!(pixel(frame, 99, 0), [1, 1, 1, 0]);
    assert_eq!(pixel(frame, 100, 0), [2, 2, 2, 0]);
    // Below the shorter display: black.
    assert_eq!(pixel(frame, 50, 60), [0, 0, 0, 0]);
    // Back to one display.
    capturer.select(View::Display(0)).unwrap();
    capturer.capture(false).unwrap();
    assert_eq!(capturer.frame().width, 100);
}

#[test]
fn kms_all_screens_uses_mutters_layout_for_frame_cursor_and_pointer() {
    let fake = two_side_by_side();
    fake.0.lock().unwrap().cursors = vec![(
        "b".into(),
        KmsCursor {
            visible: true,
            x: 10,
            y: 20,
            shape: 7,
        },
    )];
    let mutter = FakeMutter::new(Ok(stacked()));
    let (mut capturer, pointer) = capturer(&fake, Box::new(mutter.clone()));
    let rects: Vec<Rect> = capturer.displays().iter().map(DisplayInfo::rect).collect();
    assert_eq!(
        rects,
        vec![Rect::new(0, 0, 100, 50), Rect::new(50, 50, 200, 80)]
    );
    // Mutter's primary is the one the session opens on.
    assert_eq!(capturer.view(), View::Display(1));
    assert_eq!(
        *pointer.lock().unwrap(),
        PointerMap::new(vec![
            Mapped {
                desktop: Rect::new(0, 0, 100, 50),
                stage: Rect::new(0, 0, 100, 50)
            },
            Mapped {
                desktop: Rect::new(50, 50, 200, 80),
                stage: Rect::new(50, 50, 200, 80)
            },
        ])
    );
    capturer.select(View::All).unwrap();
    capturer.capture(true).unwrap();
    let frame = capturer.frame();
    assert_eq!((frame.width, frame.height), (250, 130));
    assert_eq!(pixel(frame, 99, 49), [1, 1, 1, 0]);
    assert_eq!(pixel(frame, 50, 50), [2, 2, 2, 0]);
    assert_eq!(pixel(frame, 0, 50), [0, 0, 0, 0]);
    assert_eq!(pixel(frame, 200, 0), [0, 0, 0, 0]);
    // The cursor is on b: desktop units, in the combined frame.
    let cursor = capturer.cursor().unwrap();
    assert_eq!((cursor.x, cursor.y, cursor.visible), (60, 70, true));

    // Mutter is asked again after a while, not on every poll.
    let calls = *mutter.calls.lock().unwrap();
    capturer.next_layout = Instant::now();
    assert!(!capturer.poll_layout().unwrap());
    assert_eq!(*mutter.calls.lock().unwrap(), calls);
    capturer.next_layout = Instant::now();
    capturer.next_mutter = Instant::now();
    // Someone dragged b to the right of a in Settings.
    let mut moved = stacked();
    moved.logical[1].x = 100;
    moved.logical[1].y = 0;
    *mutter.state.lock().unwrap() = Ok(moved);
    assert!(capturer.poll_layout().unwrap());
    assert_eq!(*mutter.calls.lock().unwrap(), calls + 1);
    assert_eq!(capturer.view(), View::All);
    assert_eq!(capturer.displays()[1].rect(), Rect::new(100, 0, 200, 80));
    assert_eq!((capturer.frame().width, capturer.frame().height), (300, 80));
}

#[test]
fn kms_falls_back_side_by_side_when_the_bus_call_fails() {
    let fake = two_side_by_side();
    let mutter = FakeMutter::new(Err("busctl exited with 1".into()));
    let (mut capturer, pointer) = capturer(&fake, Box::new(mutter.clone()));
    let rects: Vec<Rect> = capturer.displays().iter().map(DisplayInfo::rect).collect();
    assert_eq!(
        rects,
        vec![Rect::new(0, 0, 100, 50), Rect::new(100, 0, 200, 80)]
    );
    assert_eq!(*pointer.lock().unwrap(), PointerMap::identity(&rects));
    // The same failure again changes nothing (and logs nothing).
    capturer.next_layout = Instant::now();
    capturer.next_mutter = Instant::now();
    assert!(!capturer.poll_layout().unwrap());
    // Mutter answers later: the real layout from then on.
    *mutter.state.lock().unwrap() = Ok(stacked());
    capturer.next_layout = Instant::now();
    capturer.next_mutter = Instant::now();
    assert!(capturer.poll_layout().unwrap());
    assert_eq!(capturer.displays()[1].rect(), Rect::new(50, 50, 200, 80));
}

#[test]
fn kms_single_display_never_asks_mutter_and_cannot_show_all() {
    let fake = FakeKms::default();
    fake.0.lock().unwrap().displays = vec![display("a", 0, 100, 50)];
    let mutter = FakeMutter::new(Ok(stacked()));
    let (mut capturer, pointer) = capturer(&fake, Box::new(mutter.clone()));
    assert_eq!(*mutter.calls.lock().unwrap(), 0);
    assert!(!capturer.can_show_all());
    assert!(capturer.select(View::All).is_err());
    assert_eq!(capturer.view(), View::Display(0));
    assert_eq!(
        *pointer.lock().unwrap(),
        PointerMap::identity(&[Rect::new(0, 0, 100, 50)])
    );
}

#[test]
fn kms_all_screens_falls_back_to_one_display_when_one_is_unplugged() {
    let fake = two_side_by_side();
    let (mut capturer, _) = capturer(&fake, Box::new(NoLayout("greeter".into())));
    capturer.select(View::All).unwrap();
    fake.0.lock().unwrap().displays = vec![display("b", 0, 200, 80)];
    capturer.next_layout = Instant::now();
    assert!(capturer.poll_layout().unwrap());
    assert_eq!(capturer.view(), View::Display(0));
    capturer.capture(false).unwrap();
    assert_eq!(capturer.frame().width, 200);
}
