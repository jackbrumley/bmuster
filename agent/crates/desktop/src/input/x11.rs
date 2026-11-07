//! X11 input through XTest (SPEC-DESKTOP 5.3, 6.1).
//!
//! The keyboard-map loading, keysym search and character-to-keysym rules
//! come from Voquill's `platform/linux/x11/input.rs` (Jack Brumley,
//! AGPL-3.0-only; only lines Jack wrote, checked with `git blame`). BMuster
//! adds keys by position, AltGr (level 3) characters and a spare key code
//! for characters the layout lacks.

use super::keymap::KeyPosition;
use super::{Axis, Button, InputBackend, InputError, InputResult, WHEEL_NOTCH};
use crate::capture::x11_session::{connect, X11Target};
use std::collections::HashMap;
use x11rb::connection::{Connection, RequestConnection};
use x11rb::protocol::xproto::{
    ConnectionExt as _, Keycode, Keysym, Window, BUTTON_PRESS_EVENT, BUTTON_RELEASE_EVENT,
    KEY_PRESS_EVENT, KEY_RELEASE_EVENT, MOTION_NOTIFY_EVENT,
};
use x11rb::protocol::xtest::{self, ConnectionExt as _};
use x11rb::rust_connection::RustConnection;

const XK_SHIFT_L: Keysym = 0xFFE1;
const XK_SHIFT_R: Keysym = 0xFFE2;
const XK_ISO_LEVEL3_SHIFT: Keysym = 0xFE03;
const XK_MODE_SWITCH: Keysym = 0xFF7E;
const XK_RETURN: Keysym = 0xFF0D;
const XK_TAB: Keysym = 0xFF09;
const NO_SYMBOL: Keysym = 0;
/// X key code = evdev key code + 8.
const EVDEV_OFFSET: u16 = 8;

fn failed<E: std::fmt::Display>(what: &'static str) -> impl FnOnce(E) -> InputError {
    move |error| InputError(format!("{what}: {error}"))
}

/// The keysyms a character may be listed under: the legacy Latin-1 keysym
/// (equal to the code point) and the Unicode keysym (0x0100_0000 + code point).
pub fn char_keysyms(character: char) -> Vec<Keysym> {
    let code = character as u32;
    match character {
        '\n' => vec![XK_RETURN],
        '\t' => vec![XK_TAB],
        // EuroSign predates the Unicode keysyms and layouts still use it.
        '€' => vec![0x20AC, 0x0100_20AC],
        _ if (0x20..=0x7E).contains(&code) || (0xA0..=0xFF).contains(&code) => {
            vec![code, 0x0100_0000 + code]
        }
        _ => vec![0x0100_0000 + code],
    }
}

/// How to type a keysym with the current keyboard map.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResolvedKey {
    pub keycode: Keycode,
    pub shift: bool,
    pub level3: bool,
}

/// The core keyboard map: `per_keycode` keysyms for each key code from `min`.
#[derive(Debug, Clone)]
pub struct KeyboardMap {
    pub min: Keycode,
    pub per_keycode: usize,
    pub keysyms: Vec<Keysym>,
}

impl KeyboardMap {
    fn load(connection: &RustConnection) -> InputResult<KeyboardMap> {
        let setup = connection.setup();
        let (min, max) = (setup.min_keycode, setup.max_keycode);
        let reply = connection
            .get_keyboard_mapping(min, max - min + 1)
            .map_err(failed("GetKeyboardMapping"))?
            .reply()
            .map_err(failed("GetKeyboardMapping"))?;
        Ok(KeyboardMap {
            min,
            per_keycode: usize::from(reply.keysyms_per_keycode).max(1),
            keysyms: reply.keysyms,
        })
    }

    fn rows(&self) -> impl Iterator<Item = (Keycode, &[Keysym])> {
        self.keysyms
            .chunks(self.per_keycode)
            .enumerate()
            .map(|(index, row)| (self.min.saturating_add(index as u8), row))
    }

    /// The first key code listing any of `targets` in any column.
    pub fn keycode_for(&self, targets: &[Keysym]) -> Option<Keycode> {
        self.rows()
            .find(|(_, row)| row.iter().any(|k| targets.contains(k)))
            .map(|(keycode, _)| keycode)
    }

    /// Where a keysym can be typed. Core-map columns from XKB are: 0 and 1
    /// plain and Shift (group 1), 2 and 3 group 2, 4 and 5 AltGr and
    /// AltGr+Shift (group 1, level 3 and 4). Groups other than 1 are skipped.
    pub fn resolve(&self, keysym: Keysym) -> Option<ResolvedKey> {
        for (column, shift, level3) in [
            (0, false, false),
            (1, true, false),
            (4, false, true),
            (5, true, true),
        ] {
            for (keycode, row) in self.rows() {
                if row.get(column) == Some(&keysym) {
                    return Some(ResolvedKey {
                        keycode,
                        shift,
                        level3,
                    });
                }
            }
        }
        None
    }

    /// Key codes with no keysyms, free to borrow for unmapped characters.
    pub fn spare_keycodes(&self) -> Vec<Keycode> {
        self.rows()
            .filter(|(keycode, row)| *keycode > 8 && row.iter().all(|&k| k == NO_SYMBOL))
            .map(|(keycode, _)| keycode)
            .collect()
    }
}

/// XTest injection into one X display.
pub struct XTestInput {
    connection: RustConnection,
    root: Window,
    min_keycode: Keycode,
    max_keycode: Keycode,
    map: KeyboardMap,
    shift: Keycode,
    level3: Keycode,
    spare: Vec<Keycode>,
    next_spare: usize,
    /// Characters currently mapped onto spare key codes.
    borrowed: HashMap<Keysym, Keycode>,
    wheel: [i32; 2],
}

impl XTestInput {
    pub fn open(target: &X11Target) -> InputResult<XTestInput> {
        let (connection, screen) = connect(target).map_err(InputError)?;
        if connection
            .extension_information(xtest::X11_EXTENSION_NAME)
            .map_err(failed("querying X extensions"))?
            .is_none()
        {
            return Err(InputError("the X server has no XTEST extension".into()));
        }
        connection
            .xtest_get_version(2, 2)
            .map_err(failed("XTest version"))?
            .reply()
            .map_err(failed("XTest version"))?;
        let setup = connection.setup();
        let root = setup
            .roots
            .get(screen)
            .ok_or_else(|| InputError("the X server has no such screen".into()))?
            .root;
        let (min_keycode, max_keycode) = (setup.min_keycode, setup.max_keycode);
        let map = KeyboardMap::load(&connection)?;
        let shift = map.keycode_for(&[XK_SHIFT_L, XK_SHIFT_R]).unwrap_or(50);
        // AltGr: the layout's level-3 key, else Mode_switch, else Right Alt.
        let level3 = map
            .keycode_for(&[XK_ISO_LEVEL3_SHIFT])
            .or_else(|| map.keycode_for(&[XK_MODE_SWITCH]))
            .unwrap_or(100 + EVDEV_OFFSET as u8);
        let spare = map.spare_keycodes();
        Ok(XTestInput {
            connection,
            root,
            min_keycode,
            max_keycode,
            map,
            shift,
            level3,
            spare,
            next_spare: 0,
            borrowed: HashMap::new(),
            wheel: [0; 2],
        })
    }

    fn fake(&self, kind: u8, detail: u8, x: i16, y: i16) -> InputResult<()> {
        self.connection
            .xtest_fake_input(kind, detail, 0, self.root, x, y, 0)
            .map_err(failed("XTestFakeInput"))?;
        Ok(())
    }

    fn keycode(&self, keycode: Keycode, down: bool) -> InputResult<()> {
        let kind = if down {
            KEY_PRESS_EVENT
        } else {
            KEY_RELEASE_EVENT
        };
        self.fake(kind, keycode, 0, 0)
    }

    /// Maps `keysym` onto a spare key code (reused round-robin, restored when
    /// the session ends).
    fn borrow_keycode(&mut self, keysym: Keysym) -> InputResult<Keycode> {
        if let Some(&keycode) = self.borrowed.get(&keysym) {
            return Ok(keycode);
        }
        if self.spare.is_empty() {
            return Err(InputError(format!(
                "no free key code to type keysym {keysym:#x}"
            )));
        }
        let keycode = self.spare[self.next_spare % self.spare.len()];
        self.next_spare += 1;
        self.borrowed.retain(|_, k| *k != keycode);
        let row = vec![keysym; self.map.per_keycode];
        self.connection
            .change_keyboard_mapping(1, keycode, self.map.per_keycode as u8, &row)
            .map_err(failed("ChangeKeyboardMapping"))?;
        self.borrowed.insert(keysym, keycode);
        Ok(keycode)
    }

    fn restore_borrowed(&mut self) {
        let empty = vec![NO_SYMBOL; self.map.per_keycode];
        for (_, keycode) in self.borrowed.drain() {
            let _ = self.connection.change_keyboard_mapping(
                1,
                keycode,
                self.map.per_keycode as u8,
                &empty,
            );
        }
        let _ = self.connection.flush();
    }
}

impl Drop for XTestInput {
    fn drop(&mut self) {
        self.restore_borrowed();
    }
}

fn x_button(button: Button) -> u8 {
    match button {
        Button::Left => 1,
        Button::Middle => 2,
        Button::Right => 3,
        Button::Back => 8,
        Button::Forward => 9,
    }
}

impl InputBackend for XTestInput {
    fn move_pointer(&mut self, x: i32, y: i32) -> InputResult<()> {
        let clamp = |v: i32| v.clamp(i32::from(i16::MIN), i32::from(i16::MAX)) as i16;
        // Detail 0: absolute position on `root`.
        self.fake(MOTION_NOTIFY_EVENT, 0, clamp(x), clamp(y))
    }

    fn button(&mut self, button: Button, down: bool) -> InputResult<()> {
        let kind = if down {
            BUTTON_PRESS_EVENT
        } else {
            BUTTON_RELEASE_EVENT
        };
        self.fake(kind, x_button(button), 0, 0)
    }

    fn scroll(&mut self, axis: Axis, units: i32) -> InputResult<()> {
        // X scrolls in whole clicks: 4 up, 5 down, 6 left, 7 right.
        let (index, back, forward) = match axis {
            Axis::Vertical => (0, 4, 5),
            Axis::Horizontal => (1, 6, 7),
        };
        self.wheel[index] += units;
        while self.wheel[index].abs() >= WHEEL_NOTCH {
            let positive = self.wheel[index] > 0;
            let button = if positive { forward } else { back };
            self.fake(BUTTON_PRESS_EVENT, button, 0, 0)?;
            self.fake(BUTTON_RELEASE_EVENT, button, 0, 0)?;
            self.wheel[index] -= if positive { WHEEL_NOTCH } else { -WHEEL_NOTCH };
        }
        Ok(())
    }

    fn key(&mut self, key: &KeyPosition, down: bool) -> InputResult<()> {
        let keycode = key.evdev + EVDEV_OFFSET;
        if keycode < u16::from(self.min_keycode) || keycode > u16::from(self.max_keycode) {
            return Err(InputError(format!(
                "{} (key code {keycode}) is outside this X server's key codes",
                key.code
            )));
        }
        self.keycode(keycode as u8, down)
    }

    fn alt_gr(&mut self, down: bool) -> InputResult<()> {
        self.keycode(self.level3, down)
    }

    fn type_char(&mut self, character: char) -> InputResult<()> {
        let keysyms = char_keysyms(character);
        let resolved = keysyms.iter().find_map(|&k| self.map.resolve(k));
        let key = match resolved {
            Some(key) => key,
            None => ResolvedKey {
                keycode: self.borrow_keycode(keysyms[keysyms.len() - 1])?,
                shift: false,
                level3: false,
            },
        };
        if key.level3 {
            self.keycode(self.level3, true)?;
        }
        if key.shift {
            self.keycode(self.shift, true)?;
        }
        self.keycode(key.keycode, true)?;
        self.keycode(key.keycode, false)?;
        if key.shift {
            self.keycode(self.shift, false)?;
        }
        if key.level3 {
            self.keycode(self.level3, false)?;
        }
        Ok(())
    }

    fn secure_attention(&mut self) -> InputResult<bool> {
        Ok(false)
    }

    fn flush(&mut self) -> InputResult<()> {
        self.connection
            .flush()
            .map_err(failed("flushing X requests"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map() -> KeyboardMap {
        // Key codes 10..=13 with 6 columns: a/A, q (AltGr @), empty, Shift_L.
        KeyboardMap {
            min: 10,
            per_keycode: 6,
            keysyms: vec![
                0x61,
                0x41,
                0x61,
                0x41,
                0,
                0, //
                0x71,
                0x51,
                0x71,
                0x51,
                0x40,
                0x0100_03A9, //
                0,
                0,
                0,
                0,
                0,
                0, //
                XK_SHIFT_L,
                0,
                0,
                0,
                0,
                0,
            ],
        }
    }

    #[test]
    fn x11_keysym_resolution_by_column() {
        let map = map();
        let at = |keycode, shift, level3| {
            Some(ResolvedKey {
                keycode,
                shift,
                level3,
            })
        };
        assert_eq!(map.resolve(0x61), at(10, false, false));
        assert_eq!(map.resolve(0x41), at(10, true, false));
        assert_eq!(map.resolve(0x40), at(11, false, true));
        assert_eq!(map.resolve(0x0100_03A9), at(11, true, true));
        assert_eq!(map.resolve(0x20AC), None);
        assert_eq!(map.keycode_for(&[XK_SHIFT_L]), Some(13));
        assert_eq!(map.spare_keycodes(), vec![12]);
    }

    #[test]
    fn x11_character_keysyms() {
        assert_eq!(char_keysyms('a'), vec![0x61, 0x0100_0061]);
        assert_eq!(char_keysyms('é'), vec![0xE9, 0x0100_00E9]);
        assert_eq!(char_keysyms('€'), vec![0x20AC, 0x0100_20AC]);
        assert_eq!(char_keysyms('Ω'), vec![0x0100_03A9]);
        assert_eq!(char_keysyms('\n'), vec![XK_RETURN]);
    }
}
