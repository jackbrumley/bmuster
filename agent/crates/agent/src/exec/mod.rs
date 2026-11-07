//! Starting and ending the processes a session runs: the shell for a
//! terminal (a pseudo-terminal) and single commands for exec (pipes), in
//! the agent's process or as transient systemd services ([`placement`]).

pub mod pipe;
pub mod placement;
#[cfg_attr(unix, path = "pty_unix.rs")]
#[cfg_attr(windows, path = "pty_windows.rs")]
pub mod pty;
pub mod spawn;
pub mod tree;
#[cfg(target_os = "linux")]
pub mod unit;

/// A terminal's size in character cells.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PtySize {
    pub cols: u16,
    pub rows: u16,
}

impl PtySize {
    /// The browser's size, kept within what a terminal can sensibly be.
    pub fn clamped(cols: u16, rows: u16) -> Self {
        Self {
            cols: cols.clamp(2, 1000),
            rows: rows.clamp(1, 500),
        }
    }
}
