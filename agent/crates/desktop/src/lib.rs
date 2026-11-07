//! BMuster remote desktop (SPEC-DESKTOP): screen capture, input injection
//! and the JPEG tile encoder, behind one session type that the session
//! socket code drives.
//!
//! - [`session::DesktopSession`]: browser text frames in, binary frames and
//!   JSON control messages out; [`session::run`] loops it over a channel.
//! - [`capture`]: X11 (XShm, XDamage, RandR, XFixes) and Windows (DXGI
//!   Desktop Duplication, GDI fallback).
//! - [`input`]: XTest and `SendInput`, with release-all.
//! - [`notice`]: the bar at the machine while someone is connected.
//! - [`follow`]: a session that follows the screen at the machine (the
//!   sign-in screen, a desktop, a switch between them) without ending.
//! - [`encode`], [`frame`], [`pacing`], [`control`]: the wire format and the
//!   pure logic, tested without a display.
//!
//! [`open_console`] says how a session gets this machine's screen: on Linux
//! it follows seat0, on Windows the input desktop of the helper's session.

pub mod capture;
pub mod control;
pub mod encode;
pub mod follow;
pub mod frame;
pub mod input;
pub mod notice;
pub mod pacing;
pub mod session;
pub mod winsession;

pub use control::{EndReason, Mode};
pub use follow::{Look, ScreenWatch};
pub use session::{run, DesktopSession, Incoming, Outgoing, SessionSlot};

use capture::Capturer;
use input::{InputBackend, InputResult};

/// A capturer for the console, a way to make its injector (called only
/// for a control session) and where to show the notice bar.
pub struct Platform {
    pub capturer: Box<dyn Capturer>,
    pub make_input: Box<dyn FnOnce() -> InputResult<Box<dyn InputBackend>> + Send>,
    pub notice_target: notice::Target,
}

/// How a session gets the machine's screen.
pub enum Console {
    /// One screen for the whole session.
    Fixed(Platform),
    /// Whatever the physical screen shows, followed as it changes.
    Following(Box<dyn ScreenWatch>),
}

/// Follows seat0's active session through logind (Linux).
#[cfg(target_os = "linux")]
pub fn open_console() -> Result<Console, String> {
    Ok(Console::Following(Box::new(
        capture::x11_follow::LogindWatch::new(),
    )))
}

/// Follows the input desktop of the console session the desktop helper
/// runs in: Default, or Winlogon for the sign-in screen, the lock screen and
/// UAC prompts (Windows).
#[cfg(windows)]
pub fn open_console() -> Result<Console, String> {
    Ok(Console::Following(Box::new(
        capture::windows_follow::InputDesktopWatch,
    )))
}

/// One fixed screen elsewhere (none yet: macOS comes later).
#[cfg(not(any(target_os = "linux", windows)))]
pub fn open_console() -> Result<Console, String> {
    open_platform().map(Console::Fixed)
}

/// Capture, input and the notice bar on one X display (Linux).
#[cfg(target_os = "linux")]
pub fn x11_platform(target: capture::x11_session::X11Target) -> Result<Platform, String> {
    let capturer = capture::x11::X11Capturer::open(&target).map_err(|e| e.0)?;
    let notice_target = target.clone();
    Ok(Platform {
        capturer: Box::new(capturer),
        make_input: Box::new(move || {
            Ok(Box::new(input::x11::XTestInput::open(&target)?) as Box<dyn InputBackend>)
        }),
        notice_target,
    })
}

/// Opens capture on the current input desktop (Windows; the helper process
/// runs this in the console session).
#[cfg(windows)]
pub fn open_platform() -> Result<Platform, String> {
    let capturer = capture::windows::open().map_err(|e| e.0)?;
    Ok(Platform {
        capturer,
        make_input: Box::new(|| {
            Ok(Box::new(input::windows::SendInputBackend::new()) as Box<dyn InputBackend>)
        }),
        notice_target: notice::Target,
    })
}

/// No desktop capture on other platforms yet (macOS comes later).
#[cfg(not(any(target_os = "linux", windows)))]
pub fn open_platform() -> Result<Platform, String> {
    Err("Remote desktop is not available on this platform yet".to_string())
}
