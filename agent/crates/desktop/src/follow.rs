//! Following the machine's screen (SPEC-DESKTOP 6.1, "As built: following
//! the screen"): the session shows whatever the physical screen shows (the
//! sign-in screen, someone's desktop, a switch between them) without ending.
//!
//! A [`ScreenWatch`] says what the screen shows now ([`ScreenWatch::look`],
//! about once a second) and opens capture and input on it
//! ([`ScreenWatch::open`]). The session reopens everything whenever the
//! look's key changes, and stays open in [`DesktopState::Unavailable`] while
//! there is nothing to show. Linux watches seat0 through logind
//! (`capture::x11_follow`); tests drive their own watch.

use crate::capture::{
    CaptureError, CaptureResult, Capturer, CursorImage, CursorState, Damage, DesktopState,
    DisplayInfo, Frame,
};
use crate::Platform;

/// One look at the screen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Look {
    /// Changes whenever the screen is another one (a new logind session or
    /// display); the session then reopens capture and input.
    pub key: String,
    /// What it shows. A change with the same key (lock, unlock) is only
    /// reported to the browser.
    pub state: DesktopState,
    /// The screen is there but its display is off (blanked on idle): a
    /// control session sends a wake nudge (SPEC-DESKTOP-WAKE).
    pub dark: bool,
}

/// Sends harmless input that wakes the screen and resets the machine's idle
/// timers (SPEC-DESKTOP-WAKE): only ever made for a control session.
pub trait Waker: Send {
    fn nudge(&mut self) -> Result<(), String>;
}

/// What a following session asks of the platform.
pub trait ScreenWatch: Send {
    fn request_approval(&mut self) -> Result<(), String> {
        Err("This screen does not use portal approval".into())
    }
    /// What the screen shows now. Cheap enough to call once a second.
    fn look(&mut self) -> Look;

    /// Opens capture, input and the notice bar's target on the screen the
    /// last [`ScreenWatch::look`] saw. Never called while that look was
    /// [`DesktopState::Unavailable`].
    fn open(&mut self) -> Result<Platform, String>;

    /// The wake device, asked for once when a control session starts.
    fn waker(&mut self) -> Result<Box<dyn Waker>, String> {
        Err("This screen cannot be woken".into())
    }
}

/// The capturer a following session holds while there is no screen. The
/// session never captures from it; it lists no displays.
pub(crate) struct NoScreen {
    frame: Frame,
}

impl NoScreen {
    pub(crate) fn new() -> Self {
        NoScreen {
            frame: Frame::new(0, 0),
        }
    }
}

impl Capturer for NoScreen {
    fn displays(&self) -> &[DisplayInfo] {
        &[]
    }
    fn current(&self) -> usize {
        0
    }
    fn select(&mut self, _index: usize) -> CaptureResult<()> {
        Err(CaptureError::new("there is no screen to show"))
    }
    fn poll_layout(&mut self) -> CaptureResult<bool> {
        Ok(false)
    }
    fn capture(&mut self, _full: bool) -> CaptureResult<Damage> {
        Err(CaptureError::new("there is no screen to show"))
    }
    fn frame(&self) -> &Frame {
        &self.frame
    }
    fn cursor(&mut self) -> CaptureResult<CursorState> {
        Err(CaptureError::new("there is no screen to show"))
    }
    fn cursor_image(&mut self, _id: u32) -> CaptureResult<Option<CursorImage>> {
        Ok(None)
    }
    fn state(&self) -> DesktopState {
        DesktopState::Unavailable {
            reason: "There is no screen to show".to_string(),
        }
    }

    fn backend(&self) -> &'static str {
        "none"
    }
}

/// How the screen is read and driven (SPEC-CONSOLE-CAPTURE, table C1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScreenPath {
    /// XShm and XDamage capture, XTest input.
    X11,
    /// KMS scanout capture, uinput input.
    Kms,
}

/// The path for a logind session `Type`: X11 sessions (greeters too) keep
/// X11; Wayland greeters, lock screens and desktops, text consoles and no
/// session at all (`""`) go through KMS.
pub fn screen_path(session_type: &str) -> ScreenPath {
    match session_type {
        "x11" => ScreenPath::X11,
        _ => ScreenPath::Kms,
    }
}

/// What a KMS screen shows, from logind's `Class`, `LockedHint` and `Name`
/// (all empty for no session: a text console's login prompt).
pub fn console_state(class: &str, locked_hint: &str, name: &str) -> DesktopState {
    let user = (!name.is_empty()).then(|| name.to_string());
    match class {
        "greeter" | "" => DesktopState::SignIn,
        "lock-screen" => DesktopState::Locked { user },
        _ if locked_hint == "yes" => DesktopState::Locked { user },
        _ => DesktopState::Desktop { user },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn console_path_for_each_screen() {
        // X11 keeps XShm and XTest, whatever is on it.
        assert_eq!(screen_path("x11"), ScreenPath::X11);
        // Everything else is read from the kernel.
        for other in ["wayland", "tty", "", "mir", "unspecified"] {
            assert_eq!(screen_path(other), ScreenPath::Kms, "{other:?}");
        }
        let jack = || Some("jack".to_string());
        assert_eq!(console_state("greeter", "no", "gdm"), DesktopState::SignIn);
        assert_eq!(
            console_state("", "", ""),
            DesktopState::SignIn,
            "no session"
        );
        assert_eq!(
            console_state("lock-screen", "no", "jack"),
            DesktopState::Locked { user: jack() }
        );
        assert_eq!(
            console_state("user", "yes", "jack"),
            DesktopState::Locked { user: jack() }
        );
        assert_eq!(
            console_state("user", "no", "jack"),
            DesktopState::Desktop { user: jack() }
        );
        assert_eq!(
            console_state("user", "no", ""),
            DesktopState::Desktop { user: None }
        );
    }
}
