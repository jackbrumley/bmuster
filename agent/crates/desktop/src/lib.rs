//! BMuster remote desktop (SPEC-DESKTOP): screen capture, input injection
//! and the JPEG tile encoder, behind one session type that the session
//! socket code drives.
//!
//! - [`session::DesktopSession`]: browser text frames in, binary frames and
//!   JSON control messages out; [`session::run`] loops it over a channel.
//! - [`capture`]: X11 (XShm, XDamage, RandR, XFixes) and Windows (DXGI
//!   Desktop Duplication, GDI fallback).
//! - [`input`]: XTest and `SendInput`, with release-all.
//! - [`encode`], [`frame`], [`pacing`], [`control`]: the wire format and the
//!   pure logic, tested without a display.
//!
//! [`open_platform`] builds the capturer and the injector factory for this
//! machine's console.

pub mod capture;
pub mod control;
pub mod encode;
pub mod frame;
pub mod input;
pub mod pacing;
pub mod session;

pub use control::{EndReason, Mode};
pub use session::{run, DesktopSession, Incoming, Outgoing, SessionSlot};

use capture::Capturer;
use input::{InputBackend, InputResult};

/// A capturer for the console and a way to make its injector (called only
/// for a control session).
pub struct Platform {
    pub capturer: Box<dyn Capturer>,
    pub make_input: Box<dyn FnOnce() -> InputResult<Box<dyn InputBackend>> + Send>,
}

/// Opens capture on the active seat0 X session (Linux).
#[cfg(target_os = "linux")]
pub fn open_platform() -> Result<Platform, String> {
    let seat = capture::x11_session::find_seat0()?;
    let capturer =
        capture::x11::X11Capturer::open(&seat.target, seat.state.clone()).map_err(|e| e.0)?;
    let target = seat.target;
    Ok(Platform {
        capturer: Box::new(capturer),
        make_input: Box::new(move || {
            Ok(Box::new(input::x11::XTestInput::open(&target)?) as Box<dyn InputBackend>)
        }),
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
    })
}
