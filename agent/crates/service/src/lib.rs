//! Service plumbing shared by `bmuster-agent` and the `bmuster-server`
//! launcher: systemd units on Linux, the service manager on Windows, and a
//! size-capped log file for Windows services, which have no console.
//!
//! Each program keeps its own names, paths and unit text; only the
//! mechanics live here.

pub mod log_file;
#[cfg(target_os = "linux")]
pub mod systemd;
#[cfg(windows)]
pub mod windows;
