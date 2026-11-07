//! Following the input desktop (SPEC-DESKTOP 6.2): the lock screen, the
//! sign-in screen and the UAC prompt are the Winlogon desktop, the user's
//! programs the Default one. Capture and `SendInput` only reach the desktop
//! the calling thread is on, so the capture thread checks on every tick and
//! moves itself with `SetThreadDesktop` when the input desktop changes.
//!
//! The logic follows TigerVNC's `rfb_win32::inputDesktopSelected` and
//! `selectInputDesktop`, as RustDesk carries them (`src/platform/windows.cc`,
//! AGPL-3.0, from TigerVNC, GPL-2.0-or-later), rewritten; see NOTICE.md.
//! `SetThreadDesktop` fails while the thread owns a window or a hook, so
//! the capture thread never makes one (the notice bar has its own thread).

use ::windows::Win32::Foundation::HANDLE;
use ::windows::Win32::System::StationsAndDesktops::{
    CloseDesktop, GetThreadDesktop, GetUserObjectInformationW, OpenInputDesktop, SetThreadDesktop,
    DESKTOP_ACCESS_FLAGS, DESKTOP_CONTROL_FLAGS, DESKTOP_CREATEMENU, DESKTOP_CREATEWINDOW,
    DESKTOP_ENUMERATE, DESKTOP_HOOKCONTROL, DESKTOP_READOBJECTS, DESKTOP_SWITCHDESKTOP,
    DESKTOP_WRITEOBJECTS, HDESK, UOI_NAME,
};
use ::windows::Win32::System::Threading::GetCurrentThreadId;
use std::cell::Cell;

/// `GENERIC_WRITE`, which `SendInput` needs on the desktop.
const GENERIC_WRITE: u32 = 0x4000_0000;

thread_local! {
    /// The desktop this thread opened and moved to last; closed when the
    /// thread moves on. (The thread's first desktop belongs to the process.)
    static OPENED: Cell<Option<isize>> = const { Cell::new(None) };
}

fn access() -> DESKTOP_ACCESS_FLAGS {
    DESKTOP_ACCESS_FLAGS(
        [
            DESKTOP_CREATEMENU,
            DESKTOP_CREATEWINDOW,
            DESKTOP_ENUMERATE,
            DESKTOP_HOOKCONTROL,
            DESKTOP_WRITEOBJECTS,
            DESKTOP_READOBJECTS,
            DESKTOP_SWITCHDESKTOP,
        ]
        .iter()
        .fold(GENERIC_WRITE, |all, flag| all | flag.0),
    )
}

/// A desktop's name, like `Default` or `Winlogon`.
fn name_of(desktop: HDESK) -> Result<String, String> {
    let mut name = [0u16; 256];
    let mut needed = 0u32;
    // SAFETY: `name` is 512 bytes, as stated.
    unsafe {
        GetUserObjectInformationW(
            HANDLE(desktop.0),
            UOI_NAME,
            Some(name.as_mut_ptr().cast()),
            (name.len() * 2) as u32,
            Some(&mut needed),
        )
    }
    .map_err(|e| format!("GetUserObjectInformation: {e}"))?;
    Ok(crate::capture::windows::wide_to_string(&name))
}

/// The name of the desktop this thread is on.
pub fn thread_desktop_name() -> Result<String, String> {
    // SAFETY: the handle from GetThreadDesktop needs no closing.
    let current = unsafe { GetThreadDesktop(GetCurrentThreadId()) }
        .map_err(|e| format!("GetThreadDesktop: {e}"))?;
    name_of(current)
}

/// The input desktop's name, without moving this thread.
pub fn input_desktop_name() -> Result<String, String> {
    // SAFETY: the handle is closed before returning.
    unsafe {
        let input = OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS)
            .map_err(|e| format!("OpenInputDesktop: {e}"))?;
        let name = name_of(input);
        let _ = CloseDesktop(input);
        name
    }
}

/// Moves this thread to the input desktop if it is elsewhere. Returns the
/// input desktop's name and whether the thread moved.
pub fn follow_input_desktop() -> Result<(String, bool), String> {
    // SAFETY: the opened handle is either closed here or kept in OPENED and
    // closed when the thread next moves.
    unsafe {
        let input = OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, access())
            .map_err(|e| format!("OpenInputDesktop: {e}"))?;
        let input_name = match name_of(input) {
            Ok(name) => name,
            Err(e) => {
                let _ = CloseDesktop(input);
                return Err(e);
            }
        };
        if thread_desktop_name().is_ok_and(|current| current == input_name) {
            let _ = CloseDesktop(input);
            return Ok((input_name, false));
        }
        if let Err(e) = SetThreadDesktop(input) {
            let _ = CloseDesktop(input);
            return Err(format!("SetThreadDesktop({input_name}): {e}"));
        }
        if let Some(previous) = OPENED.with(|opened| opened.replace(Some(input.0 as isize))) {
            let _ = CloseDesktop(HDESK(previous as *mut _));
        }
        log::info!("Desktop capture moved to the {input_name} desktop");
        Ok((input_name, true))
    }
}
