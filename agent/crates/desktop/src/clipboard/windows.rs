//! The Windows clipboard (SPEC-DESKTOP 21.4) through `arboard`
//! (`clipboard-win`). The desktop helper runs in the console session's
//! window station, whose clipboard this is, on whichever desktop is the
//! input desktop. Opened for each call: the clipboard is shared with every
//! program in the session, and holding it open would block them.

use crate::input::{InputError, InputResult};

fn failed(what: &'static str) -> impl FnOnce(arboard::Error) -> InputError {
    move |error| InputError(format!("Windows clipboard, {what}: {error}"))
}

pub fn set(text: &str) -> InputResult<()> {
    arboard::Clipboard::new()
        .map_err(failed("opening it"))?
        .set_text(text)
        .map_err(failed("setting the text"))
}

/// The clipboard's text; empty when it holds none (an image, files).
pub fn get() -> InputResult<String> {
    match arboard::Clipboard::new()
        .map_err(failed("opening it"))?
        .get_text()
    {
        Ok(text) => Ok(text),
        Err(arboard::Error::ContentNotAvailable) => Ok(String::new()),
        Err(error) => Err(failed("reading the text")(error)),
    }
}

/// The window station's clipboard sequence number, which Windows bumps on
/// every change to the clipboard (SPEC-DESKTOP 21.11). Read twice a second
/// it tells the session what `WM_CLIPBOARDUPDATE` would, with no window
/// to keep.
#[derive(Default)]
pub struct Sequence(Option<u32>);

impl Sequence {
    /// Whether the clipboard changed since the last call; the first call
    /// only notes where it stands.
    pub fn changed(&mut self) -> bool {
        // SAFETY: no arguments; reads a counter of the window station.
        let now = unsafe { windows::Win32::System::DataExchange::GetClipboardSequenceNumber() };
        let changed = self.0.is_some_and(|last| last != now);
        self.0 = Some(now);
        changed
    }
}
