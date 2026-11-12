//! Typing a character as key strokes on a US layout (SPEC-CONSOLE-CAPTURE
//! version 3): used by uinput (sign-in and lock screens, and every Wayland
//! screen the console path shows) and by the Wayland portal.
//!
//! - **Shift in a frame of its own, with a settle either side.** Shift down,
//!   key down and up, Shift up written back to back reached KWin's lock
//!   screen as a lowercase letter: the letter was handled before Shift was.
//!   [`SHIFT_SETTLE`] goes after Shift down and before Shift up, and
//!   [`CHARACTER_GAP`] after every character (like ydotool's key delay).
//! - **Caps Lock.** Key strokes go through the machine's own lock state, so
//!   with Caps Lock on a letter's Shift is turned round. The state comes
//!   from the keyboard LEDs the kernel shows under `/sys/class/leds`
//!   ([`caps_lock_on`]).
//!
//! **Cost:** a character without Shift takes [`CHARACTER_GAP`] (5 ms), one
//! with Shift `2 × SHIFT_SETTLE + CHARACTER_GAP` (21 ms). The longest `text`
//! message (256 characters) takes at most about 5.4 s, all of it capitals;
//! the phone key bar sends a character or a word at a time.

use super::uinput::us_key;
use super::{InputError, InputResult};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

/// After Shift goes down and before it comes up.
pub const SHIFT_SETTLE: Duration = Duration::from_millis(8);
/// After every typed character.
pub const CHARACTER_GAP: Duration = Duration::from_millis(5);
/// `KEY_LEFTSHIFT`.
pub const SHIFT: u16 = 42;
/// Where the kernel shows LEDs, `inputN::capslock` among them.
pub const LEDS: &str = "/sys/class/leds";

/// One step of typing a character.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stroke {
    /// An evdev key code goes down or up, in a frame of its own.
    Key {
        code: u16,
        down: bool,
    },
    Pause(Duration),
}

/// The strokes that type `character` on a US layout with Caps Lock as
/// given, or `None` when the layout has no key for it. Caps Lock turns a
/// letter's Shift round and leaves digits and symbols alone, as xkb's
/// alphabetic key type does.
pub fn strokes(character: char, caps_lock: bool) -> Option<Vec<Stroke>> {
    let (key, shift) = us_key(character)?;
    let shift = shift != (caps_lock && character.is_ascii_alphabetic());
    let key = |down| Stroke::Key {
        code: key.evdev,
        down,
    };
    let shift_key = |down| Stroke::Key { code: SHIFT, down };
    Some(if shift {
        vec![
            shift_key(true),
            Stroke::Pause(SHIFT_SETTLE),
            key(true),
            key(false),
            Stroke::Pause(SHIFT_SETTLE),
            shift_key(false),
            Stroke::Pause(CHARACTER_GAP),
        ]
    } else {
        vec![key(true), key(false), Stroke::Pause(CHARACTER_GAP)]
    })
}

/// Plays `strokes`. After a failed key, keys still go up (Shift above all)
/// but no more go down; the first error is returned.
pub fn play(
    strokes: &[Stroke],
    mut key: impl FnMut(u16, bool) -> InputResult<()>,
    mut pause: impl FnMut(Duration),
) -> InputResult<()> {
    let mut first_error: Option<InputError> = None;
    for stroke in strokes {
        match *stroke {
            Stroke::Key { code, down } => {
                if down && first_error.is_some() {
                    continue;
                }
                if let Err(error) = key(code, down) {
                    first_error.get_or_insert(error);
                }
            }
            Stroke::Pause(length) => {
                if first_error.is_none() {
                    pause(length);
                }
            }
        }
    }
    first_error.map_or(Ok(()), Err)
}

/// Whether any keyboard's Caps Lock LED under `leds` is lit. The compositor
/// sets the LEDs of every keyboard it drives to its own lock state, so any
/// lit one means Caps Lock is on. No LEDs (or none readable) reads as off:
/// with no keyboard showing it, nothing says otherwise.
pub fn caps_lock_on(leds: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(leds) else {
        return false;
    };
    entries.filter_map(Result::ok).any(|entry| {
        entry.file_name().to_string_lossy().ends_with("::capslock")
            && std::fs::read_to_string(entry.path().join("brightness"))
                .ok()
                .and_then(|text| text.trim().parse::<u32>().ok())
                .is_some_and(|brightness| brightness > 0)
    })
}

/// How a session's characters are paced and how it reads Caps Lock: the
/// real clock and LEDs, or fakes in tests.
#[derive(Clone)]
pub struct Typing {
    pause: Arc<dyn Fn(Duration) + Send + Sync>,
    caps_lock: Arc<dyn Fn() -> bool + Send + Sync>,
}

impl Typing {
    /// Sleeps for real and reads [`LEDS`].
    pub fn system() -> Typing {
        Typing::with(std::thread::sleep, || caps_lock_on(Path::new(LEDS)))
    }

    pub fn with(
        pause: impl Fn(Duration) + Send + Sync + 'static,
        caps_lock: impl Fn() -> bool + Send + Sync + 'static,
    ) -> Typing {
        Typing {
            pause: Arc::new(pause),
            caps_lock: Arc::new(caps_lock),
        }
    }

    /// [`strokes`] with Caps Lock as it is now.
    pub fn strokes(&self, character: char) -> Option<Vec<Stroke>> {
        strokes(character, (self.caps_lock)())
    }

    pub fn pause(&self, length: Duration) {
        (self.pause)(length);
    }
}

#[cfg(test)]
#[path = "typing_tests.rs"]
mod tests;
