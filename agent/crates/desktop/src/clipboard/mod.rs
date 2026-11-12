//! The machine's clipboard for copy and paste (SPEC-DESKTOP 21): text only,
//! at most [`MAX_CLIPBOARD_BYTES`] each way.
//!
//! The clipboard belongs to the screen's injector ([`crate::input::InputBackend`]),
//! so it exists only in a control session: a watch-only session has no
//! injector and so no clipboard (SPEC-DESKTOP 7). X11 has its own selection
//! code ([`x11`]); Windows goes through `arboard` ([`windows`]); Wayland
//! portal sessions go through the agent's portal helper (SPEC-DESKTOP 21.9);
//! KMS with uinput reaches no clipboard at all and says so.

#[cfg(windows)]
pub mod windows;
#[cfg(target_os = "linux")]
pub mod x11;

use crate::control::MAX_CLIPBOARD_BYTES;
use crate::input::InputError;
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

/// What a screen without a reachable clipboard says (KMS and uinput).
pub fn not_available() -> InputError {
    InputError("Copy and paste is not available on this screen.".into())
}
