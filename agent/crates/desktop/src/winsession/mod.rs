//! Windows session plumbing for remote desktop (SPEC-DESKTOP 6.2).
//!
//! The agent runs as a LocalSystem service in session 0, which cannot see
//! the console's screen. For desktop sessions it starts
//! `bmuster-agent desktop-helper` in the active console session with a
//! SYSTEM token taken from that session's `winlogon.exe`, and hands it each
//! session's ticket over a named pipe only SYSTEM may open. The helper opens
//! its own session socket and follows the input desktop (Default, Winlogon,
//! the UAC secure desktop) on every capture tick.
//!
//! The pure parts build and are tested everywhere: the pipe's messages
//! ([`handoff`]), which console session to run in ([`follow`]), the
//! Ctrl+Alt+Del policy values ([`sas_policy`]) and the names shown in the
//! console ([`names`]). The Win32 parts are Windows only.

pub mod follow;
pub mod handoff;
pub mod names;
pub mod sas_policy;
