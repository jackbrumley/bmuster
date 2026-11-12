//! Windows input through `SendInput` (SPEC-DESKTOP 5.3, 6.2): keys by
//! scancode, characters with `KEYEVENTF_UNICODE`, the pointer in absolute
//! virtual-desktop coordinates. Written for BMuster from the Win32
//! documentation.

use super::absolute;
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
use std::sync::OnceLock;

/// How Ctrl+Alt+Del reaches Windows: only a service may call `SendSAS`, so
/// the desktop helper sets a hook that asks the service over its pipe.
pub type SecureAttention = Box<dyn Fn() -> Result<(), String> + Send + Sync>;

static SECURE_ATTENTION: OnceLock<SecureAttention> = OnceLock::new();

/// Sets the Ctrl+Alt+Del hook for this process (the desktop helper, once).
pub fn set_secure_attention(hook: SecureAttention) {
    if SECURE_ATTENTION.set(hook).is_err() {
        log::warn!("The Ctrl+Alt+Del hook was already set");
    }
}

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

/// Maps a virtual-desktop pixel to SendInput's 0..=65535 absolute range:
/// a quarter of a pixel in, so Windows lands on that pixel whether it
/// rounds or truncates `value * size / 65536` (SPEC-DESKTOP-ALL-SCREENS).
pub fn normalise(value: i32, origin: i32, size: i32) -> i32 {
    let last = i64::from(size.max(1)) - 1;
    let offset = (i64::from(value) - i64::from(origin)).clamp(0, last);
    absolute::axis(offset as f64 + 0.25, f64::from(size.max(1)))
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
        // A chord from SendInput never reaches Windows' secure attention
        // handler, so there is no fallback to the keys.
        let hook = SECURE_ATTENTION.get().ok_or_else(|| {
            InputError("Ctrl+Alt+Del needs the desktop helper's service connection".into())
        })?;
        hook().map_err(InputError)?;
        Ok(true)
    }

    fn flush(&mut self) -> InputResult<()> {
        Ok(())
    }

    fn set_clipboard(&mut self, text: &str) -> InputResult<()> {
        crate::clipboard::windows::set(text)
    }

    fn clipboard(&mut self) -> InputResult<String> {
        crate::clipboard::windows::get()
    }
}

/// Wakes the display and resets the idle timers (SPEC-DESKTOP-WAKE): a
/// relative mouse move of 0, 0 counts as input without moving the pointer.
#[derive(Debug, Default)]
pub struct SendInputWaker;

impl crate::follow::Waker for SendInputWaker {
    fn nudge(&mut self) -> Result<(), String> {
        send(&[mouse(0, 0, 0, MOUSEEVENTF_MOVE)]).map_err(|e| e.0)
    }
}

/// The desktop helper's input check (SPEC-DIAGNOSTICS 1): `SendInput` with
/// no events at all, which reaches the call without moving or typing.
/// Windows answers an empty list with "The parameter is incorrect"
/// (E_INVALIDARG): the call got through and only the empty list was refused,
/// so that is a pass. Blocked input (another desktop, UIPI) is a different
/// error, such as Access is denied, and fails.
pub fn check_send_input() -> Result<String, String> {
    // SAFETY: an empty slice; no INPUT is read.
    let sent = unsafe { SendInput(&[], std::mem::size_of::<INPUT>() as i32) };
    let error = ::windows::core::Error::from_thread();
    send_input_verdict(sent, error.code(), &error.to_string())
}

fn send_input_verdict(
    sent: u32,
    code: ::windows::core::HRESULT,
    message: &str,
) -> Result<String, String> {
    if sent != 0 || code.is_ok() {
        Ok("SendInput accepted an empty list in this session.".to_string())
    } else if code == ::windows::Win32::Foundation::E_INVALIDARG {
        Ok("SendInput reached this session (it refuses an empty list, as expected).".to_string())
    } else {
        Err(format!("SendInput refused: {message}"))
    }
}

#[cfg(test)]
mod tests {
    use super::{normalise, send_input_verdict};
    use ::windows::Win32::Foundation::{E_ACCESSDENIED, E_INVALIDARG, S_OK};

    /// Windows 10 answers the check's empty list with E_INVALIDARG; that
    /// was reported as a failure on a machine whose input worked.
    #[test]
    fn send_input_check_passes_the_empty_list_refusal_and_fails_access_denied() {
        assert!(send_input_verdict(0, E_INVALIDARG, "The parameter is incorrect.").is_ok());
        assert!(send_input_verdict(0, S_OK, "").is_ok());
        assert_eq!(
            send_input_verdict(0, E_ACCESSDENIED, "Access is denied."),
            Err("SendInput refused: Access is denied.".to_string())
        );
    }

    /// Where Windows puts a value, truncating and rounding.
    fn landed(value: i32, origin: i32, size: i32) -> (i32, i32) {
        let exact = f64::from(value) * f64::from(size) / 65536.0;
        (origin + exact.floor() as i32, origin + exact.round() as i32)
    }

    #[test]
    fn windows_absolute_coordinates_span_the_virtual_desktop() {
        // A monitor left of the primary: the virtual screen starts at -1920.
        for x in [-1920, -1, 0, 1919] {
            assert_eq!(landed(normalise(x, -1920, 3840), -1920, 3840), (x, x));
        }
        assert_eq!(normalise(-5000, -1920, 3840), normalise(-1920, -1920, 3840));
        assert_eq!(normalise(5000, 0, 1920), normalise(1919, 0, 1920));
    }
}
