//! The machine's clipboard for copy and paste (SPEC-DESKTOP 21): text only,
//! at most [`MAX_CLIPBOARD_BYTES`] each way.
//!
//! The clipboard belongs to the screen's injector ([`crate::input::InputBackend`]),
//! so it exists only in a control session: a watch-only session has no
//! injector and so no clipboard (SPEC-DESKTOP 7). X11 has its own selection
//! code ([`x11`]); Windows goes through `arboard` ([`windows`]); Wayland
//! portal sessions go through the agent's portal helper (SPEC-DESKTOP 21.9).
//! KMS with uinput reaches the clipboard of the person's own session
//! through a [`ScreenClipboard`] the agent supplies (a helper running as
//! that person, SPEC-DESKTOP 21.10); [`route`] decides whether a call may
//! reach it at all.

#[cfg(windows)]
pub mod windows;
#[cfg(target_os = "linux")]
pub mod x11;

mod route;
pub use route::{route, Route, LOCKED};

use crate::control::MAX_CLIPBOARD_BYTES;
use crate::input::{InputError, InputResult};
use std::time::Duration;

/// How long a read waits for the program that holds the clipboard.
pub const CLIPBOARD_WAIT: Duration = Duration::from_secs(3);

/// Text longer than the limit, at the machine.
pub fn too_large() -> InputError {
    InputError(format!(
        "The machine's clipboard holds more than {} MB of text",
        MAX_CLIPBOARD_BYTES / (1024 * 1024)
    ))
}

/// What a screen without a reachable clipboard says.
pub fn not_available() -> InputError {
    InputError("Copy and paste is not available on this screen.".into())
}

/// The clipboard of a screen whose injector cannot reach one itself (KMS
/// and uinput): the agent supplies it, one per control session's
/// injector, and it goes when the injector goes.
pub trait ScreenClipboard: Send {
    /// Makes `text` the clipboard's contents.
    fn set(&mut self, text: &str) -> InputResult<()>;
    /// The clipboard's text; empty when it holds none.
    fn get(&mut self) -> InputResult<String>;
}

/// A screen with no clipboard BMuster can reach.
pub struct NoClipboard;

impl ScreenClipboard for NoClipboard {
    fn set(&mut self, _text: &str) -> InputResult<()> {
        Err(not_available())
    }
    fn get(&mut self) -> InputResult<String> {
        Err(not_available())
    }
}
