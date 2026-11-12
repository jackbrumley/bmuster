//! Input injection (SPEC-DESKTOP 5.3, R7).
//!
//! [`InputController`] turns control messages into platform calls and keeps
//! track of every key and button it pressed, so [`InputController::release_all`]
//! (and dropping the controller) leaves nothing stuck on the machine. The
//! platform side is an [`InputBackend`]: XTest on X11, `SendInput` on Windows.

pub mod absolute;
pub mod keymap;
#[cfg(target_os = "linux")]
pub mod typing;
#[cfg(target_os = "linux")]
pub mod uinput;
#[cfg(windows)]
pub mod windows;
#[cfg(target_os = "linux")]
pub mod x11;

use crate::capture::Rect;
use crate::control::{SpecialKey, WheelMode};
use keymap::KeyPosition;

/// Wheel units per notch, as Windows counts them (`WHEEL_DELTA`).
pub const WHEEL_NOTCH: i32 = 120;
/// Browser pixels per notch (Chrome and Firefox send 100 per notch).
const PIXELS_PER_NOTCH: f64 = 100.0;
/// Browser lines per notch (Firefox sends 3 per notch).
const LINES_PER_NOTCH: f64 = 3.0;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InputError(pub String);

impl std::fmt::Display for InputError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for InputError {}

pub type InputResult<T> = Result<T, InputError>;

/// Mouse buttons, with the browser's `buttons` bit for each.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Button {
    Left,
    Right,
    Middle,
    Back,
    Forward,
}

impl Button {
    pub const ALL: [Button; 5] = [
        Button::Left,
        Button::Right,
        Button::Middle,
        Button::Back,
        Button::Forward,
    ];

    pub fn bit(self) -> u8 {
        match self {
            Button::Left => 1,
            Button::Right => 2,
            Button::Middle => 4,
            Button::Back => 8,
            Button::Forward => 16,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Axis {
    Vertical,
    Horizontal,
}

/// One platform's raw input calls. Positions are on the virtual desktop.
pub trait InputBackend: Send {
    fn move_pointer(&mut self, x: i32, y: i32) -> InputResult<()>;
    fn button(&mut self, button: Button, down: bool) -> InputResult<()>;
    /// Scrolls by `units` ([`WHEEL_NOTCH`] per notch); positive is down or right.
    fn scroll(&mut self, axis: Axis, units: i32) -> InputResult<()>;
    /// Presses or releases a physical key.
    fn key(&mut self, key: &KeyPosition, down: bool) -> InputResult<()>;
    /// Presses or releases AltGr (ISO_Level3_Shift on X11, Right Alt on Windows).
    fn alt_gr(&mut self, down: bool) -> InputResult<()>;
    /// Types one character, whatever the layout.
    fn type_char(&mut self, character: char) -> InputResult<()>;
    /// Ctrl+Alt+Del. Returns false when the platform has no special call and
    /// the key chord should be sent instead.
    fn secure_attention(&mut self) -> InputResult<bool>;
    /// Sends anything buffered.
    fn flush(&mut self) -> InputResult<()>;
    /// Puts `text` on the screen's clipboard (SPEC-DESKTOP 21). The
    /// clipboard rides on the injector so a watch-only session, which has
    /// none, can never reach it. Screens with no reachable clipboard say so.
    fn set_clipboard(&mut self, _text: &str) -> InputResult<()> {
        Err(crate::clipboard::not_available())
    }
    /// The screen's clipboard text; empty when it holds no text.
    fn clipboard(&mut self) -> InputResult<String> {
        Err(crate::clipboard::not_available())
    }
    /// Whether the screen's clipboard changed since the last call; the
    /// first call may only start watching (clipboard sharing, SPEC-DESKTOP
    /// 21.11). Cheap and never blocking: the session asks every half
    /// second. A screen without a clipboard never changes.
    fn clipboard_changed(&mut self) -> InputResult<bool> {
        Ok(false)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Held {
    Key(&'static KeyPosition),
    AltGr,
}

/// Message-level input for one session, with stuck-key protection.
pub struct InputController {
    backend: Box<dyn InputBackend>,
    held: Vec<Held>,
    buttons: u8,
    wheel: [f64; 2],
}

impl InputController {
    pub fn new(backend: Box<dyn InputBackend>) -> Self {
        InputController {
            backend,
            held: Vec::new(),
            buttons: 0,
            wheel: [0.0; 2],
        }
    }

    /// Moves the pointer to `(x, y)` in display pixels (clamped to the
    /// display) and presses or releases buttons to match `buttons`.
    pub fn pointer(&mut self, display: Rect, x: f64, y: f64, buttons: u8) -> InputResult<()> {
        let clamp = |value: f64, size: u32| value.round().clamp(0.0, f64::from(size.max(1) - 1));
        let x = display.x + clamp(x, display.width) as i32;
        let y = display.y + clamp(y, display.height) as i32;
        self.backend.move_pointer(x, y)?;
        for button in Button::ALL {
            let want = buttons & button.bit() != 0;
            let have = self.buttons & button.bit() != 0;
            if want != have {
                self.backend.button(button, want)?;
                self.buttons ^= button.bit();
            }
        }
        self.backend.flush()
    }

    pub fn wheel(&mut self, dx: f64, dy: f64, mode: WheelMode) -> InputResult<()> {
        let per_notch = match mode {
            WheelMode::Pixel => PIXELS_PER_NOTCH,
            WheelMode::Line => LINES_PER_NOTCH,
        };
        for (index, (axis, delta)) in [(Axis::Horizontal, dx), (Axis::Vertical, dy)]
            .into_iter()
            .enumerate()
        {
            self.wheel[index] += delta * f64::from(WHEEL_NOTCH) / per_notch;
            let units = self.wheel[index].trunc();
            if units != 0.0 {
                self.wheel[index] -= units;
                self.backend.scroll(axis, units as i32)?;
            }
        }
        self.backend.flush()
    }

    /// A key by position. With `alt_gr` set on `AltRight`, AltGr itself.
    pub fn key(&mut self, code: &str, key: &str, down: bool, alt_gr: bool) -> InputResult<()> {
        let held = if alt_gr && code == "AltRight" {
            Held::AltGr
        } else {
            let position = keymap::lookup(code, key)
                .ok_or_else(|| InputError(format!("unknown key code {code:?}")))?;
            Held::Key(position)
        };
        self.press(held, down)?;
        self.backend.flush()
    }

    fn press(&mut self, held: Held, down: bool) -> InputResult<()> {
        match held {
            Held::Key(position) => self.backend.key(position, down)?,
            Held::AltGr => self.backend.alt_gr(down)?,
        }
        if down {
            if !self.held.contains(&held) {
                self.held.push(held);
            }
        } else {
            self.held.retain(|h| *h != held);
        }
        Ok(())
    }

    /// Characters typed as characters; line breaks and tabs as their keys.
    /// A character the platform cannot type is skipped and the rest still
    /// go; the first such error is returned.
    pub fn text(&mut self, text: &str) -> InputResult<()> {
        let mut first_error = None;
        for character in text.chars() {
            let named = match character {
                '\n' | '\r' => Some("Enter"),
                '\t' => Some("Tab"),
                _ => None,
            };
            let result = match named.and_then(keymap::position) {
                Some(position) => self.tap(&[position]),
                None => self.backend.type_char(character),
            };
            if let Err(error) = result {
                first_error.get_or_insert(error);
            }
        }
        self.backend.flush()?;
        first_error.map_or(Ok(()), Err)
    }

    pub fn special(&mut self, name: SpecialKey) -> InputResult<()> {
        let chord: &[&str] = match name {
            SpecialKey::CtrlAltDel => {
                if self.backend.secure_attention()? {
                    return self.backend.flush();
                }
                &["ControlLeft", "AltLeft", "Delete"]
            }
            SpecialKey::Win => &["MetaLeft"],
            SpecialKey::AltTab => &["AltLeft", "Tab"],
            SpecialKey::PrintScreen => &["PrintScreen"],
        };
        let keys: Vec<&'static KeyPosition> =
            chord.iter().filter_map(|c| keymap::position(c)).collect();
        self.tap(&keys)?;
        self.backend.flush()
    }

    /// Presses the keys in order, then releases them in reverse.
    fn tap(&mut self, keys: &[&'static KeyPosition]) -> InputResult<()> {
        for key in keys {
            self.backend.key(key, true)?;
        }
        for key in keys.iter().rev() {
            self.backend.key(key, false)?;
        }
        Ok(())
    }

    /// Releases every key and button this session holds down. Every release
    /// is tried even when one fails; the first error is returned.
    /// Puts `text` on the screen's clipboard (SPEC-DESKTOP 21).
    pub fn set_clipboard(&mut self, text: &str) -> InputResult<()> {
        self.backend.set_clipboard(text)
    }

    /// The screen's clipboard text.
    pub fn clipboard(&mut self) -> InputResult<String> {
        self.backend.clipboard()
    }

    /// Whether the screen's clipboard changed since the last call.
    pub fn clipboard_changed(&mut self) -> InputResult<bool> {
        self.backend.clipboard_changed()
    }

    pub fn release_all(&mut self) -> InputResult<()> {
        let mut first_error = None;
        for held in std::mem::take(&mut self.held).into_iter().rev() {
            let result = match held {
                Held::Key(position) => self.backend.key(position, false),
                Held::AltGr => self.backend.alt_gr(false),
            };
            if let Err(error) = result {
                first_error.get_or_insert(error);
            }
        }
        for button in Button::ALL {
            if self.buttons & button.bit() != 0 {
                if let Err(error) = self.backend.button(button, false) {
                    first_error.get_or_insert(error);
                }
            }
        }
        self.buttons = 0;
        self.wheel = [0.0; 2];
        if let Err(error) = self.backend.flush() {
            first_error.get_or_insert(error);
        }
        first_error.map_or(Ok(()), Err)
    }

    /// True while any key or button is held.
    pub fn holds_anything(&self) -> bool {
        !self.held.is_empty() || self.buttons != 0
    }
}

impl Drop for InputController {
    fn drop(&mut self) {
        if let Err(error) = self.release_all() {
            log::warn!("Releasing held keys at the end of a desktop session failed: {error}");
        }
    }
}

/// A backend that records calls, for tests in this crate and the session tests.
#[cfg(test)]
pub mod recording {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[derive(Debug, Clone, PartialEq, Eq)]
    pub enum Call {
        Move(i32, i32),
        Button(Button, bool),
        Scroll(Axis, i32),
        Key(&'static str, bool),
        AltGr(bool),
        Char(char),
        Sas,
    }

    #[derive(Clone, Default)]
    pub struct Recorder {
        pub calls: Arc<Mutex<Vec<Call>>>,
        pub has_sas: bool,
        /// The screen's clipboard; `None` is a screen without one.
        pub clipboard: Option<Arc<Mutex<String>>>,
        /// The clipboard as the last `clipboard_changed` saw it.
        pub watched: Arc<Mutex<Option<String>>>,
    }

    impl Recorder {
        pub fn take(&self) -> Vec<Call> {
            std::mem::take(&mut *self.calls.lock().unwrap())
        }

        fn push(&self, call: Call) -> InputResult<()> {
            self.calls.lock().unwrap().push(call);
            Ok(())
        }
    }

    impl InputBackend for Recorder {
        fn move_pointer(&mut self, x: i32, y: i32) -> InputResult<()> {
            self.push(Call::Move(x, y))
        }
        fn button(&mut self, button: Button, down: bool) -> InputResult<()> {
            self.push(Call::Button(button, down))
        }
        fn scroll(&mut self, axis: Axis, units: i32) -> InputResult<()> {
            self.push(Call::Scroll(axis, units))
        }
        fn key(&mut self, key: &KeyPosition, down: bool) -> InputResult<()> {
            self.push(Call::Key(key.code, down))
        }
        fn alt_gr(&mut self, down: bool) -> InputResult<()> {
            self.push(Call::AltGr(down))
        }
        fn type_char(&mut self, character: char) -> InputResult<()> {
            self.push(Call::Char(character))
        }
        fn secure_attention(&mut self) -> InputResult<bool> {
            if self.has_sas {
                self.push(Call::Sas)?;
            }
            Ok(self.has_sas)
        }
        fn flush(&mut self) -> InputResult<()> {
            Ok(())
        }
        fn set_clipboard(&mut self, text: &str) -> InputResult<()> {
            match &self.clipboard {
                Some(held) => {
                    *held.lock().unwrap() = text.to_string();
                    Ok(())
                }
                None => Err(crate::clipboard::not_available()),
            }
        }
        fn clipboard(&mut self) -> InputResult<String> {
            match &self.clipboard {
                Some(held) => Ok(held.lock().unwrap().clone()),
                None => Err(crate::clipboard::not_available()),
            }
        }
        fn clipboard_changed(&mut self) -> InputResult<bool> {
            let Some(held) = &self.clipboard else {
                return Ok(false);
            };
            let now = held.lock().unwrap().clone();
            let mut watched = self.watched.lock().unwrap();
            let changed = watched.as_ref().is_some_and(|seen| *seen != now);
            *watched = Some(now);
            Ok(changed)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::recording::{Call, Recorder};
    use super::*;

    fn controller() -> (InputController, Recorder) {
        let recorder = Recorder::default();
        (InputController::new(Box::new(recorder.clone())), recorder)
    }

    #[test]
    fn input_pointer_is_clamped_offset_and_buttons_follow_the_mask() {
        let (mut input, rec) = controller();
        let display = Rect::new(1920, 0, 1280, 800);
        input.pointer(display, 10.4, 20.6, 1).unwrap();
        input.pointer(display, 5000.0, -3.0, 1 | 2).unwrap();
        input.pointer(display, 0.0, 0.0, 2).unwrap();
        assert_eq!(
            rec.take(),
            vec![
                Call::Move(1930, 21),
                Call::Button(Button::Left, true),
                Call::Move(1920 + 1279, 0),
                Call::Button(Button::Right, true),
                Call::Move(1920, 0),
                Call::Button(Button::Left, false),
            ]
        );
    }

    #[test]
    fn input_wheel_converts_pixels_and_lines_and_keeps_remainders() {
        let (mut input, rec) = controller();
        input.wheel(0.0, 100.0, WheelMode::Pixel).unwrap();
        input.wheel(0.0, 50.0, WheelMode::Pixel).unwrap();
        input.wheel(0.0, 50.0, WheelMode::Pixel).unwrap();
        input.wheel(-3.0, 0.0, WheelMode::Line).unwrap();
        assert_eq!(
            rec.take(),
            vec![
                Call::Scroll(Axis::Vertical, 120),
                Call::Scroll(Axis::Vertical, 60),
                Call::Scroll(Axis::Vertical, 60),
                Call::Scroll(Axis::Horizontal, -120),
            ]
        );
    }

    #[test]
    fn input_alt_gr_is_its_own_key_and_plain_alt_right_is_not() {
        let (mut input, rec) = controller();
        input.key("AltRight", "AltGraph", true, true).unwrap();
        input.key("KeyQ", "@", true, false).unwrap();
        input.key("KeyQ", "@", false, false).unwrap();
        input.key("AltRight", "AltGraph", false, true).unwrap();
        input.key("AltRight", "Alt", true, false).unwrap();
        assert_eq!(
            rec.take(),
            vec![
                Call::AltGr(true),
                Call::Key("KeyQ", true),
                Call::Key("KeyQ", false),
                Call::AltGr(false),
                Call::Key("AltRight", true),
            ]
        );
        assert!(input.key("NoSuchKey", "x", true, false).is_err());
    }

    #[test]
    fn input_release_all_after_a_mix_of_presses() {
        let (mut input, rec) = controller();
        input.key("ShiftLeft", "Shift", true, false).unwrap();
        input.key("ControlLeft", "Control", true, false).unwrap();
        input.key("KeyA", "A", true, false).unwrap();
        input.key("KeyA", "A", false, false).unwrap();
        input.key("AltRight", "AltGraph", true, true).unwrap();
        input
            .pointer(Rect::new(0, 0, 100, 100), 1.0, 1.0, 1 | 4)
            .unwrap();
        assert!(input.holds_anything());
        rec.take();
        input.release_all().unwrap();
        assert_eq!(
            rec.take(),
            vec![
                Call::AltGr(false),
                Call::Key("ControlLeft", false),
                Call::Key("ShiftLeft", false),
                Call::Button(Button::Left, false),
                Call::Button(Button::Middle, false),
            ]
        );
        assert!(!input.holds_anything());
        input.release_all().unwrap();
        assert!(rec.take().is_empty());
    }

    #[test]
    fn input_dropping_the_controller_releases_held_keys() {
        let (mut input, rec) = controller();
        input.key("MetaLeft", "Meta", true, false).unwrap();
        rec.take();
        drop(input);
        assert_eq!(rec.take(), vec![Call::Key("MetaLeft", false)]);
    }

    #[test]
    fn input_text_types_characters_and_named_keys() {
        let (mut input, rec) = controller();
        input.text("a€\n").unwrap();
        assert_eq!(
            rec.take(),
            vec![
                Call::Char('a'),
                Call::Char('€'),
                Call::Key("Enter", true),
                Call::Key("Enter", false),
            ]
        );
    }

    #[test]
    fn input_special_keys_are_chords_unless_the_platform_has_sas() {
        let (mut input, rec) = controller();
        input.special(SpecialKey::CtrlAltDel).unwrap();
        input.special(SpecialKey::AltTab).unwrap();
        assert_eq!(
            rec.take(),
            vec![
                Call::Key("ControlLeft", true),
                Call::Key("AltLeft", true),
                Call::Key("Delete", true),
                Call::Key("Delete", false),
                Call::Key("AltLeft", false),
                Call::Key("ControlLeft", false),
                Call::Key("AltLeft", true),
                Call::Key("Tab", true),
                Call::Key("Tab", false),
                Call::Key("AltLeft", false),
            ]
        );
        let recorder = Recorder {
            has_sas: true,
            ..Recorder::default()
        };
        let mut input = InputController::new(Box::new(recorder.clone()));
        input.special(SpecialKey::CtrlAltDel).unwrap();
        assert_eq!(recorder.take(), vec![Call::Sas]);
    }
}
