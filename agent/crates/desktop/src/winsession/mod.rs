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

pub mod command_line;
pub mod follow;
pub mod handoff;
pub mod names;
pub mod sas_policy;

#[cfg(windows)]
pub mod console;
#[cfg(windows)]
pub mod input_desktop;
#[cfg(windows)]
pub mod launch;
#[cfg(windows)]
pub mod pipe;
#[cfg(windows)]
pub mod sas;

/// Called once when the helper starts: per-monitor DPI awareness, so the
/// display rectangles, the cursor position and `SendInput` all use real
/// pixels, as DXGI does. Without it Windows scales them on high-DPI screens
/// and clicks land in the wrong place.
#[cfg(windows)]
pub fn prepare_helper_process() {
    use ::windows::Win32::UI::HiDpi::{
        SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
    };
    // SAFETY: a process-wide setting made before any window or capture.
    if let Err(error) =
        unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) }
    {
        log::warn!("Could not make the desktop helper DPI aware: {error}");
    }
}
