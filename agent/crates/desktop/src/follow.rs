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
}
