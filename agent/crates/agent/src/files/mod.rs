//! File actions for a `files` session (SPEC-FILES). They run as the agent
//! (root or SYSTEM); the server checked the `files` permission and so did
//! the ticket. Every path and name is checked first ([`paths`]); deleting
//! and walking never follow links ([`ops`]).
//!
//! This module knows nothing about sockets: `sessions::files` turns requests
//! into calls here and the results into replies.

pub mod ops;
pub mod paths;
pub mod roots;
pub mod transfer;

use bmuster_protocol::files::ErrorCode;
use std::io;

/// A request that failed: a code for the server and words for the person.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileError {
    pub code: ErrorCode,
    pub message: String,
}

impl FileError {
    pub fn new(code: ErrorCode, message: String) -> Self {
        Self { code, message }
    }

    pub fn invalid(message: String) -> Self {
        Self::new(ErrorCode::Invalid, message)
    }

    /// An I/O error about `what` (a path as the person sees it).
    pub fn io(error: &io::Error, what: &str) -> Self {
        let code = match error.kind() {
            io::ErrorKind::NotFound => ErrorCode::NotFound,
            io::ErrorKind::PermissionDenied => ErrorCode::Denied,
            io::ErrorKind::AlreadyExists => ErrorCode::Exists,
            io::ErrorKind::DirectoryNotEmpty => ErrorCode::NotEmpty,
            io::ErrorKind::StorageFull | io::ErrorKind::QuotaExceeded => ErrorCode::NoSpace,
            _ => ErrorCode::Io,
        };
        let message = match code {
            ErrorCode::NotFound => format!("{what} does not exist."),
            ErrorCode::Denied => format!("The agent may not use {what}: {error}."),
            ErrorCode::Exists => format!("{what} already exists."),
            ErrorCode::NotEmpty => format!("{what} is not empty."),
            ErrorCode::NoSpace => format!("There is not enough space for {what}."),
            _ => format!("{what}: {error}."),
        };
        Self::new(code, message)
    }
}

impl std::fmt::Display for FileError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for FileError {}

/// Milliseconds since 1970 of a time, if the platform has it.
fn millis(time: io::Result<std::time::SystemTime>) -> Option<i64> {
    let since = time.ok()?.duration_since(std::time::UNIX_EPOCH).ok()?;
    i64::try_from(since.as_millis()).ok()
}
