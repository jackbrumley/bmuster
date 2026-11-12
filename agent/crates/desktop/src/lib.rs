//! BMuster remote desktop (SPEC-DESKTOP): screen capture, input injection
//! and the JPEG tile encoder, behind one session type that the session
//! socket code drives.
//!
//! - [`session::DesktopSession`]: browser text frames in, binary frames and
//!   JSON control messages out; [`session::run`] loops it over a channel.
//! - [`capture`]: X11 (XShm, XDamage, RandR, XFixes), the Linux console
//!   through KMS (SPEC-CONSOLE-CAPTURE) and Windows (DXGI Desktop
//!   Duplication, GDI fallback).
//! - [`input`]: XTest, uinput and `SendInput`, with release-all.
//! - [`clipboard`]: copy and paste on X11 and Windows (Wayland portal
//!   sessions in the agent's helper), carried by the control session's
//!   injector.
//! - [`notice`]: the bar at the machine while someone is connected.
//! - [`follow`]: a session that follows the screen at the machine (the
//!   sign-in screen, a desktop, a switch between them) without ending.
//! - [`encode`], [`frame`], [`pacing`], [`control`]: the wire format and the
//!   pure logic, tested without a display.
//!
//! [`open_console`] says how a session gets this machine's screen: on Linux
//! it follows seat0, on Windows the input desktop of the helper's session.

pub mod auto_quality;
pub mod capture;
pub mod clipboard;
pub mod control;
pub mod encode;
pub mod follow;
pub mod frame;
pub mod input;
#[cfg(target_os = "linux")]
mod ioctl;
pub mod notice;
pub mod pacing;
pub mod session;
pub mod winsession;

pub use control::{EndReason, Mode};
pub use follow::{Look, ScreenWatch, Waker};
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
        notice_target: notice_target.into(),
    })
}

/// Capture through KMS (from `source`, the root helper's pipe) laid out by
/// `layout` (mutter or KWin, on a GNOME or KDE Plasma desktop), and input
/// through uinput, built by `uinput` only for a control session (Linux:
/// Wayland, the text console, anything that is not X11).
#[cfg(target_os = "linux")]
pub fn kms_platform(
    source: capture::kms::capturer::SharedSource,
    uinput: input::uinput::Opener,
    layout: Box<dyn capture::kms::compositor::LayoutReader>,
) -> Result<Platform, String> {
    let pointer = capture::kms::capturer::unset_pointer();
    let capturer = capture::kms::capturer::KmsCapturer::new(source, pointer.clone(), layout)
        .map_err(|e| e.0)?;
    Ok(Platform {
        capturer: Box::new(capturer),
        make_input: Box::new(move || uinput.backend(pointer)),
        notice_target: notice::Target::Console,
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
