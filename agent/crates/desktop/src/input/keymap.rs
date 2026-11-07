//! Keyboard by position (SPEC-DESKTOP 5.3): `KeyboardEvent.code` to the
//! physical key on the machine, so the machine's own layout decides the
//! character.
//!
//! - X11: the Linux evdev key code; the X key code is that plus 8 on every
//!   current X server (the evdev and libinput drivers, Xephyr, Xvfb).
//! - Windows: the set-1 scancode for `SendInput`; `0xE0xx` marks an extended
//!   key. Pause has no single scancode and goes as a virtual key.
//!
//! Written from the USB HID to PS/2 tables in the UI Events KeyboardEvent
//! code values spec (W3C) and `linux/input-event-codes.h`.

/// One physical key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct KeyPosition {
    /// `KeyboardEvent.code`.
    pub code: &'static str,
    /// Linux evdev key code (`KEY_*`).
    pub evdev: u16,
    /// Windows set-1 scancode, `0xE0xx` for extended keys, 0 for none.
    pub scancode: u16,
}

const fn key(code: &'static str, evdev: u16, scancode: u16) -> KeyPosition {
    KeyPosition {
        code,
        evdev,
        scancode,
    }
}

/// Every key the browser can name by position.
pub const KEYS: &[KeyPosition] = &[
    key("Escape", 1, 0x01),
    key("Digit1", 2, 0x02),
    key("Digit2", 3, 0x03),
    key("Digit3", 4, 0x04),
    key("Digit4", 5, 0x05),
    key("Digit5", 6, 0x06),
    key("Digit6", 7, 0x07),
    key("Digit7", 8, 0x08),
    key("Digit8", 9, 0x09),
    key("Digit9", 10, 0x0A),
    key("Digit0", 11, 0x0B),
    key("Minus", 12, 0x0C),
    key("Equal", 13, 0x0D),
    key("Backspace", 14, 0x0E),
    key("Tab", 15, 0x0F),
    key("KeyQ", 16, 0x10),
    key("KeyW", 17, 0x11),
    key("KeyE", 18, 0x12),
    key("KeyR", 19, 0x13),
    key("KeyT", 20, 0x14),
    key("KeyY", 21, 0x15),
    key("KeyU", 22, 0x16),
    key("KeyI", 23, 0x17),
    key("KeyO", 24, 0x18),
    key("KeyP", 25, 0x19),
    key("BracketLeft", 26, 0x1A),
    key("BracketRight", 27, 0x1B),
    key("Enter", 28, 0x1C),
    key("ControlLeft", 29, 0x1D),
    key("KeyA", 30, 0x1E),
    key("KeyS", 31, 0x1F),
    key("KeyD", 32, 0x20),
    key("KeyF", 33, 0x21),
    key("KeyG", 34, 0x22),
    key("KeyH", 35, 0x23),
    key("KeyJ", 36, 0x24),
    key("KeyK", 37, 0x25),
    key("KeyL", 38, 0x26),
    key("Semicolon", 39, 0x27),
    key("Quote", 40, 0x28),
    key("Backquote", 41, 0x29),
    key("ShiftLeft", 42, 0x2A),
    key("Backslash", 43, 0x2B),
    key("KeyZ", 44, 0x2C),
    key("KeyX", 45, 0x2D),
    key("KeyC", 46, 0x2E),
    key("KeyV", 47, 0x2F),
    key("KeyB", 48, 0x30),
    key("KeyN", 49, 0x31),
    key("KeyM", 50, 0x32),
    key("Comma", 51, 0x33),
    key("Period", 52, 0x34),
    key("Slash", 53, 0x35),
    key("ShiftRight", 54, 0x36),
    key("NumpadMultiply", 55, 0x37),
    key("AltLeft", 56, 0x38),
    key("Space", 57, 0x39),
    key("CapsLock", 58, 0x3A),
    key("F1", 59, 0x3B),
    key("F2", 60, 0x3C),
    key("F3", 61, 0x3D),
    key("F4", 62, 0x3E),
    key("F5", 63, 0x3F),
    key("F6", 64, 0x40),
    key("F7", 65, 0x41),
    key("F8", 66, 0x42),
    key("F9", 67, 0x43),
    key("F10", 68, 0x44),
    key("NumLock", 69, 0x45),
    key("ScrollLock", 70, 0x46),
    key("Numpad7", 71, 0x47),
    key("Numpad8", 72, 0x48),
    key("Numpad9", 73, 0x49),
    key("NumpadSubtract", 74, 0x4A),
    key("Numpad4", 75, 0x4B),
    key("Numpad5", 76, 0x4C),
    key("Numpad6", 77, 0x4D),
    key("NumpadAdd", 78, 0x4E),
    key("Numpad1", 79, 0x4F),
    key("Numpad2", 80, 0x50),
    key("Numpad3", 81, 0x51),
    key("Numpad0", 82, 0x52),
    key("NumpadDecimal", 83, 0x53),
    key("IntlBackslash", 86, 0x56),
    key("F11", 87, 0x57),
    key("F12", 88, 0x58),
    key("IntlRo", 89, 0x73),
    key("NumpadEnter", 96, 0xE01C),
    key("ControlRight", 97, 0xE01D),
    key("NumpadDivide", 98, 0xE035),
    key("PrintScreen", 99, 0xE037),
    key("AltRight", 100, 0xE038),
    key("Home", 102, 0xE047),
    key("ArrowUp", 103, 0xE048),
    key("PageUp", 104, 0xE049),
    key("ArrowLeft", 105, 0xE04B),
    key("ArrowRight", 106, 0xE04D),
    key("End", 107, 0xE04F),
    key("ArrowDown", 108, 0xE050),
    key("PageDown", 109, 0xE051),
    key("Insert", 110, 0xE052),
    key("Delete", 111, 0xE053),
    key("AudioVolumeMute", 113, 0xE020),
    key("AudioVolumeDown", 114, 0xE02E),
    key("AudioVolumeUp", 115, 0xE030),
    key("NumpadEqual", 117, 0x59),
    key("Pause", 119, 0),
    key("NumpadComma", 121, 0x7E),
    key("IntlYen", 124, 0x7D),
    key("MetaLeft", 125, 0xE05B),
    key("MetaRight", 126, 0xE05C),
    key("ContextMenu", 127, 0xE05D),
    key("F13", 183, 0x64),
    key("F14", 184, 0x65),
    key("F15", 185, 0x66),
    key("F16", 186, 0x67),
    key("F17", 187, 0x68),
    key("F18", 188, 0x69),
    key("F19", 189, 0x6A),
    key("F20", 190, 0x6B),
    key("F21", 191, 0x6C),
    key("F22", 192, 0x6D),
    key("F23", 193, 0x6E),
    key("F24", 194, 0x76),
];

/// The key for a `code`, or for a named `key` value when the code is empty
/// or unknown (some phone keyboards send `Enter` with no code).
pub fn lookup(code: &str, key: &str) -> Option<&'static KeyPosition> {
    let find = |name: &str| KEYS.iter().find(|k| k.code == name);
    find(code).or_else(|| match key {
        "Enter" | "Backspace" | "Tab" | "Escape" | "Delete" | "Insert" | "Home" | "End"
        | "PageUp" | "PageDown" | "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" => find(key),
        _ => None,
    })
}

/// Looks up a code from the table (for chords the agent builds itself).
pub fn position(code: &str) -> Option<&'static KeyPosition> {
    KEYS.iter().find(|k| k.code == code)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keymap_codes_and_numbers_are_unique() {
        for (i, a) in KEYS.iter().enumerate() {
            for b in &KEYS[i + 1..] {
                assert_ne!(a.code, b.code);
                assert_ne!(a.evdev, b.evdev, "{} and {}", a.code, b.code);
                if a.scancode != 0 {
                    assert_ne!(a.scancode, b.scancode, "{} and {}", a.code, b.code);
                }
            }
        }
    }

    #[test]
    fn keymap_known_positions() {
        let a = lookup("KeyA", "a").unwrap();
        // X key code 38 is `a` on a US layout.
        assert_eq!((a.evdev + 8, a.scancode), (38, 0x1E));
        let alt_gr = lookup("AltRight", "AltGraph").unwrap();
        assert_eq!((alt_gr.evdev + 8, alt_gr.scancode), (108, 0xE038));
        assert_eq!(lookup("ArrowLeft", "ArrowLeft").unwrap().scancode, 0xE04B);
        assert_eq!(lookup("", "Enter").unwrap().code, "Enter");
        assert_eq!(lookup("", "a"), None);
        assert_eq!(lookup("Unidentified", "x"), None);
    }
}
