//! Files sent through a desktop session (SPEC-SESSION-FILES).
//!
//! Everything here that touches a file runs in the user files helper
//! (`bmuster-agent user-files`), which the agent starts **as the person
//! signed in on the screen**: a transient unit with their uid on Linux
//! ([`start`]), their unelevated token on Windows. So the kernel is the
//! boundary: the helper can do only what the person's own programs can,
//! and what it saves is theirs. The root or SYSTEM side never opens a path
//! in the person's home; it only relays frames ([`crate::sessions`]).
//!
//! - [`names`]: the strict name rules and the " (2)" numbering.
//! - [`folder`]: finding Downloads, and opening Downloads/BMuster as a
//!   real folder the person owns, never through a link.
//! - [`write`]: part files, resuming, the size and SHA-256 check, and the
//!   rename that never replaces.
//! - [`notice`]: the tray notice file for a finished drop, and the tray's
//!   distrustful reading of it.
//! - [`serve`]: the helper's request loop.
//! - [`screen`]: who is on the screen (logind, or the console session),
//!   read by the agent before anything starts.

pub mod clipboard;
pub mod folder;
pub mod names;
pub mod notice;
pub mod offers;
pub mod screen;
pub mod serve;
pub mod start;
pub mod write;

use bmuster_protocol::user_files::UserFilesError;

/// Tests that set the helper's environment (`HOME`, `XDG_RUNTIME_DIR`) take turns.
#[cfg(all(test, unix))]
pub(crate) static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
use std::io;

/// A request that failed: a code for the server and words for the person.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserError {
    pub code: UserFilesError,
    pub message: String,
}

impl UserError {
    pub fn new(code: UserFilesError, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(UserFilesError::Invalid, message)
    }

    /// An I/O error while saving `name` into `user`'s folder called `label`.
    pub fn io(error: &io::Error, name: &str, user: &str, label: &str) -> Self {
        let quota = || {
            Self::new(
                UserFilesError::Quota,
                format!("{user} is over their disk quota on the machine."),
            )
        };
        match error.raw_os_error() {
            #[cfg(unix)]
            Some(libc::EDQUOT) => return quota(),
            #[cfg(windows)]
            // ERROR_DISK_QUOTA_EXCEEDED
            Some(1295) => return quota(),
            _ => {}
        }
        match error.kind() {
            io::ErrorKind::StorageFull => Self::new(
                UserFilesError::NoSpace,
                format!("The machine's disk filled up while saving {name}."),
            ),
            io::ErrorKind::QuotaExceeded => quota(),
            io::ErrorKind::PermissionDenied => Self::new(
                UserFilesError::Denied,
                format!("BMuster couldn't write to {user}'s {label} folder: permission denied."),
            ),
            _ => Self::new(
                UserFilesError::Io,
                format!("BMuster couldn't save {name}: {error}."),
            ),
        }
    }
}

impl std::fmt::Display for UserError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for UserError {}
