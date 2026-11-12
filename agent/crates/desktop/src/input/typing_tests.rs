//! SPEC-CONSOLE-CAPTURE version 3: the strokes for a character with Caps
//! Lock off and on, playing them, and reading Caps Lock from the LEDs.

use super::*;
use std::sync::Mutex;

const A: u16 = 30;
const ONE: u16 = 2;

fn down(code: u16) -> Stroke {
    Stroke::Key { code, down: true }
}

fn up(code: u16) -> Stroke {
    Stroke::Key { code, down: false }
}

fn shifted(code: u16) -> Vec<Stroke> {
    vec![
        down(SHIFT),
        Stroke::Pause(SHIFT_SETTLE),
        down(code),
        up(code),
        Stroke::Pause(SHIFT_SETTLE),
        up(SHIFT),
        Stroke::Pause(CHARACTER_GAP),
    ]
}

fn plain(code: u16) -> Vec<Stroke> {
    vec![down(code), up(code), Stroke::Pause(CHARACTER_GAP)]
}

/// K1, K2: Shift has frames of its own with a settle either side, and
/// Caps Lock turns a letter's Shift round but leaves symbols alone.
#[test]
fn strokes_with_caps_lock_off_and_on() {
    // Caps Lock off.
    assert_eq!(strokes('A', false), Some(shifted(A)));
    assert_eq!(strokes('a', false), Some(plain(A)));
    assert_eq!(strokes('!', false), Some(shifted(ONE)));
    assert_eq!(strokes('1', false), Some(plain(ONE)));
    // Caps Lock on: letters swap, the rest stay.
    assert_eq!(strokes('A', true), Some(plain(A)));
    assert_eq!(strokes('a', true), Some(shifted(A)));
    assert_eq!(strokes('!', true), Some(shifted(ONE)));
    assert_eq!(strokes('1', true), Some(plain(ONE)));
    assert_eq!(strokes('/', true), Some(plain(53)));
    // Nothing for a character the US layout lacks.
    assert_eq!(strokes('€', false), None);
    // The pacing stays small: the longest message types in under 6 s.
    let worst = 2 * SHIFT_SETTLE + CHARACTER_GAP;
    assert!(worst * 256 < Duration::from_secs(6));
}

#[derive(Debug, PartialEq)]
enum Played {
    Key(u16, bool),
    Pause(Duration),
}

/// K3: after a failed key nothing else goes down, Shift still comes up,
/// and the first error is returned.
#[test]
fn play_releases_after_a_failure() {
    let log = Mutex::new(Vec::new());
    play(
        &shifted(A),
        |code, down| {
            log.lock().unwrap().push(Played::Key(code, down));
            Ok(())
        },
        |length| log.lock().unwrap().push(Played::Pause(length)),
    )
    .unwrap();
    assert_eq!(
        log.lock().unwrap().drain(..).collect::<Vec<_>>(),
        vec![
            Played::Key(SHIFT, true),
            Played::Pause(SHIFT_SETTLE),
            Played::Key(A, true),
            Played::Key(A, false),
            Played::Pause(SHIFT_SETTLE),
            Played::Key(SHIFT, false),
            Played::Pause(CHARACTER_GAP),
        ]
    );

    let error = play(
        &shifted(A),
        |code, down| {
            log.lock().unwrap().push(Played::Key(code, down));
            if code == A && down {
                Err(InputError("the key failed".into()))
            } else {
                Ok(())
            }
        },
        |length| log.lock().unwrap().push(Played::Pause(length)),
    )
    .unwrap_err();
    assert_eq!(error.0, "the key failed");
    assert_eq!(
        log.lock().unwrap().drain(..).collect::<Vec<_>>(),
        vec![
            Played::Key(SHIFT, true),
            Played::Pause(SHIFT_SETTLE),
            Played::Key(A, true),
            Played::Key(A, false),
            Played::Key(SHIFT, false),
        ]
    );
}

/// K4: Caps Lock is on when any keyboard's `::capslock` LED is lit.
#[test]
fn caps_lock_from_the_leds() {
    let leds = tempfile::tempdir().unwrap();
    let led = |name: &str, brightness: &str| {
        let folder = leds.path().join(name);
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("brightness"), brightness).unwrap();
    };
    assert!(!caps_lock_on(&leds.path().join("missing")), "no LEDs: off");
    led("input3::numlock", "1\n");
    led("input3::capslock", "0\n");
    led("input9::capslock", "0\n");
    assert!(!caps_lock_on(leds.path()), "num lock alone is not caps");
    led("input9::capslock", "1\n");
    assert!(caps_lock_on(leds.path()), "one lit keyboard is enough");

    let typing = Typing::with(|_| {}, || true);
    assert_eq!(typing.strokes('a'), Some(shifted(A)));
}
