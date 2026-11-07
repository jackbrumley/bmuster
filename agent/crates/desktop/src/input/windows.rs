//! Windows input through `SendInput` (SPEC-DESKTOP 5.3, 6.2): keys by
//! scancode, characters with `KEYEVENTF_UNICODE`, the pointer in absolute
//! virtual-desktop coordinates. Written for BMuster from the Win32
//! documentation.

use super::keymap::KeyPosition;
use super::{Axis, Button, InputBackend, InputError, InputResult};
use ::windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYBD_EVENT_FLAGS,
    KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE, KEYEVENTF_UNICODE,
    MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_HWHEEL, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP,
    MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN,
    MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_VIRTUALDESK, MOUSEEVENTF_WHEEL, MOUSEEVENTF_XDOWN,
    MOUSEEVENTF_XUP, MOUSEINPUT, MOUSE_EVENT_FLAGS, VIRTUAL_KEY, VK_PAUSE,
};
use ::windows::Win32::UI::WindowsAndMessaging::{
    GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
};

const XBUTTON1: u32 = 1;
const XBUTTON2: u32 = 2;
/// Right Alt, which is AltGr on layouts that have it.
const ALT_GR_SCANCODE: u16 = 0xE038;

#[derive(Default)]
pub struct SendInputBackend;

impl SendInputBackend {
    pub fn new() -> Self {
        SendInputBackend
    }
}

fn send(inputs: &[INPUT]) -> InputResult<()> {
    // SAFETY: `inputs` is a valid slice of INPUT structures of the stated size.
    let sent = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) };
    if sent as usize == inputs.len() {
        Ok(())
    } else {
        Err(InputError(format!(
            "SendInput sent {sent} of {} events (blocked by UIPI or another desktop?)",
            inputs.len()
        )))
    }
}

fn mouse(dx: i32, dy: i32, data: u32, flags: MOUSE_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx,
                dy,
                mouseData: data,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

fn keyboard(vk: VIRTUAL_KEY, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: scan,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

/// A key by set-1 scancode; `0xE0xx` is an extended key.
fn scancode_input(scancode: u16, down: bool) -> INPUT {
    let mut flags = KEYEVENTF_SCANCODE;
    if scancode & 0xFF00 == 0xE000 {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    if !down {
        flags |= KEYEVENTF_KEYUP;
    }
    keyboard(VIRTUAL_KEY(0), scancode & 0xFF, flags)
}

/// Maps a virtual-desktop pixel to SendInput's 0..=65535 absolute range.
pub fn normalise(value: i32, origin: i32, size: i32) -> i32 {
    let span = (size - 1).max(1);
    (((value - origin).clamp(0, span) as i64 * 65535 + i64::from(span) / 2) / i64::from(span))
        as i32
}

impl InputBackend for SendInputBackend {
    fn move_pointer(&mut self, x: i32, y: i32) -> InputResult<()> {
        // SAFETY: GetSystemMetrics only reads system values.
        let (left, top, width, height) = unsafe {
            (
                GetSystemMetrics(SM_XVIRTUALSCREEN),
                GetSystemMetrics(SM_YVIRTUALSCREEN),
                GetSystemMetrics(SM_CXVIRTUALSCREEN),
                GetSystemMetrics(SM_CYVIRTUALSCREEN),
            )
        };
        send(&[mouse(
            normalise(x, left, width),
            normalise(y, top, height),
            0,
            MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
        )])
    }

    fn button(&mut self, button: Button, down: bool) -> InputResult<()> {
        let (flags, data) = match (button, down) {
            (Button::Left, true) => (MOUSEEVENTF_LEFTDOWN, 0),
            (Button::Left, false) => (MOUSEEVENTF_LEFTUP, 0),
            (Button::Right, true) => (MOUSEEVENTF_RIGHTDOWN, 0),
            (Button::Right, false) => (MOUSEEVENTF_RIGHTUP, 0),
            (Button::Middle, true) => (MOUSEEVENTF_MIDDLEDOWN, 0),
            (Button::Middle, false) => (MOUSEEVENTF_MIDDLEUP, 0),
            (Button::Back, true) => (MOUSEEVENTF_XDOWN, XBUTTON1),
            (Button::Back, false) => (MOUSEEVENTF_XUP, XBUTTON1),
            (Button::Forward, true) => (MOUSEEVENTF_XDOWN, XBUTTON2),
            (Button::Forward, false) => (MOUSEEVENTF_XUP, XBUTTON2),
        };
        send(&[mouse(0, 0, data, flags)])
    }

    fn scroll(&mut self, axis: Axis, units: i32) -> InputResult<()> {
        // Windows: positive vertical is up (the browser's is down); positive
        // horizontal is right in both.
        let (flags, amount) = match axis {
            Axis::Vertical => (MOUSEEVENTF_WHEEL, -units),
            Axis::Horizontal => (MOUSEEVENTF_HWHEEL, units),
        };
        // mouseData carries a signed value in a DWORD.
        send(&[mouse(0, 0, amount as u32, flags)])
    }

    fn key(&mut self, key: &KeyPosition, down: bool) -> InputResult<()> {
        if key.scancode == 0 {
            // Pause has no single scancode; send it as a virtual key.
            let flags = if down {
                KEYBD_EVENT_FLAGS(0)
            } else {
                KEYEVENTF_KEYUP
            };
            return send(&[keyboard(VK_PAUSE, 0, flags)]);
        }
        send(&[scancode_input(key.scancode, down)])
    }

    fn alt_gr(&mut self, down: bool) -> InputResult<()> {
        send(&[scancode_input(ALT_GR_SCANCODE, down)])
    }

    fn type_char(&mut self, character: char) -> InputResult<()> {
        let mut units = [0u16; 2];
        let mut inputs = Vec::with_capacity(4);
        for &unit in character.encode_utf16(&mut units).iter() {
            inputs.push(keyboard(VIRTUAL_KEY(0), unit, KEYEVENTF_UNICODE));
            inputs.push(keyboard(
                VIRTUAL_KEY(0),
                unit,
                KEYEVENTF_UNICODE | KEYEVENTF_KEYUP,
            ));
        }
        send(&inputs)
    }

    fn secure_attention(&mut self) -> InputResult<bool> {
        Err(InputError(
            "Ctrl+Alt+Del needs SendSAS from the service, which comes with the secure desktop work (phase 3)"
                .into(),
        ))
    }

    fn flush(&mut self) -> InputResult<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::normalise;

    #[test]
    fn windows_absolute_coordinates_span_the_virtual_desktop() {
        assert_eq!(normalise(-1920, -1920, 3840), 0);
        assert_eq!(normalise(1919, -1920, 3840), 65535);
        assert_eq!(normalise(5000, 0, 1920), 65535);
    }
}
