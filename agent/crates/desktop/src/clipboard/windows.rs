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
