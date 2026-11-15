//! Who is on the screen (SPEC-SESSION-FILES 3.1, 4.3, SF3, SF11), read by
//! the agent itself, never named by the browser or the server: logind's
//! active session on seat0 (Linux), the active console session (Windows).
//! Files go only to a person's own unlocked session; at the sign-in screen
//! nobody receives them, and a locked session is refused so nothing
//! arrives while the person is away.

#[cfg(any(target_os = "linux", test))]
use std::collections::HashMap;

/// The first uid of a person's account (`UID_MIN` in login.defs).
#[cfg(any(target_os = "linux", test))]
const FIRST_UID: u32 = 1000;
/// `nobody`.
#[cfg(any(target_os = "linux", test))]
const NOBODY: u32 = 65534;

/// What the screen shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OnScreen {
    /// A person's own unlocked session: their uid (Linux) or console
    /// session id (Windows).
    Person {
        id: u32,
    },
    Nobody,
    Locked,
}

/// What the browser is told while nobody can receive files.
pub fn refusal(
    on_screen: &OnScreen,
    machine: &str,
) -> Option<(bmuster_protocol::user_files::UserFilesError, String)> {
    use bmuster_protocol::user_files::UserFilesError;
    match on_screen {
        OnScreen::Person { .. } => None,
        OnScreen::Nobody => Some((
            UserFilesError::Nobody,
            format!(
                "Nobody is signed in on {machine}, so there is no Downloads folder to send to."
            ),
        )),
        OnScreen::Locked => Some((
            UserFilesError::Locked,
            "The machine is locked. Unlock it, then send the files again.".into(),
        )),
    }
}

#[cfg(any(target_os = "linux", test))]
/// Linux: from logind's `Type`, `Class`, `User`, `State` and `LockedHint`
/// of seat0's active session (empty for none).
pub fn from_logind(properties: &HashMap<String, String>) -> OnScreen {
    let get = |key: &str| properties.get(key).map(String::as_str).unwrap_or("");
    match get("Class") {
        "lock-screen" => return OnScreen::Locked,
        "user" => {}
        // The greeter, a background session, or no session at all.
        _ => return OnScreen::Nobody,
    }
    if get("State") == "closing" || !matches!(get("Type"), "wayland" | "x11") {
        return OnScreen::Nobody;
    }
    let uid = match get("User").parse::<u32>() {
        Ok(uid) if uid >= FIRST_UID && uid != NOBODY => uid,
        _ => return OnScreen::Nobody,
    };
    if get("LockedHint") != "no" {
        // Locked, or logind could not say: refuse rather than guess.
        return OnScreen::Locked;
    }
    OnScreen::Person { id: uid }
}

/// What the machine's screen shows now.
#[cfg(target_os = "linux")]
pub fn now() -> OnScreen {
    use bmuster_desktop::capture::x11_follow::{active_session, session_properties};
    let session = match active_session() {
        Ok(session) if !session.trim().is_empty() => session,
        _ => return OnScreen::Nobody,
    };
    match session_properties(session.trim()) {
        Ok(properties) => from_logind(&properties),
        Err(error) => {
            log::warn!("Cannot read the session on the screen: {error}");
            OnScreen::Nobody
        }
    }
}

/// What the machine's screen shows now: the active console session's
/// person, unless it is locked.
#[cfg(windows)]
pub fn now() -> OnScreen {
    use bmuster_desktop::winsession::console::{active_console_session, session_user};
    let session = active_console_session();
    if session == u32::MAX || session == 0 || session_user(session).is_none() {
        return OnScreen::Nobody;
    }
    if windows_locked(session) {
        OnScreen::Locked
    } else {
        OnScreen::Person { id: session }
    }
}

/// Whether Windows says `session` is locked (`WTSSessionInfoEx`); a
/// session whose state cannot be read counts as locked.
#[cfg(windows)]
fn windows_locked(session: u32) -> bool {
    use windows::core::PWSTR;
    use windows::Win32::System::RemoteDesktop::{
        WTSFreeMemory, WTSQuerySessionInformationW, WTSSessionInfoEx, WTSINFOEXW,
        WTS_CURRENT_SERVER_HANDLE,
    };
    /// `WTS_SESSIONSTATE_UNLOCK`.
    const UNLOCKED: i32 = 1;
    let mut buffer = PWSTR::null();
    let mut length = 0u32;
    // SAFETY: WTS allocates the buffer, read here as the WTSINFOEXW it is
    // for this class, and freed once.
    unsafe {
        if WTSQuerySessionInformationW(
            Some(WTS_CURRENT_SERVER_HANDLE),
            session,
            WTSSessionInfoEx,
            &mut buffer,
            &mut length,
        )
        .is_err()
            || buffer.is_null()
            || (length as usize) < std::mem::size_of::<WTSINFOEXW>()
        {
            return true;
        }
        let info = &*buffer.0.cast::<WTSINFOEXW>();
        let flags = info.Data.WTSInfoExLevel1.SessionFlags;
        WTSFreeMemory(buffer.0.cast());
        flags != UNLOCKED
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(text: &str) -> OnScreen {
        from_logind(
            &text
                .lines()
                .filter_map(|line| line.split_once('='))
                .map(|(key, value)| (key.to_string(), value.to_string()))
                .collect(),
        )
    }

    /// SF11: a locked screen is refused; the sign-in screen has nobody.
    #[test]
    fn sf11_a_locked_screen_is_refused() {
        assert_eq!(
            read("Type=wayland\nClass=user\nUser=1000\nState=active\nLockedHint=no"),
            OnScreen::Person { id: 1000 }
        );
        assert_eq!(
            read("Type=x11\nClass=user\nUser=1001\nState=active\nLockedHint=yes"),
            OnScreen::Locked
        );
        assert_eq!(
            read("Type=wayland\nClass=user\nUser=1000\nState=active"),
            OnScreen::Locked
        );
        assert_eq!(
            read("Type=wayland\nClass=lock-screen\nUser=1000"),
            OnScreen::Locked
        );
        for nobody in [
            "",
            "Type=wayland\nClass=greeter\nUser=60578\nLockedHint=no",
            "Type=tty\nClass=user\nUser=1000\nLockedHint=no",
            "Type=wayland\nClass=user\nUser=0\nLockedHint=no",
            "Type=wayland\nClass=user\nUser=65534\nLockedHint=no",
            "Type=wayland\nClass=user\nUser=999\nLockedHint=no",
            "Type=wayland\nClass=user\nUser=1000\nState=closing\nLockedHint=no",
        ] {
            assert_eq!(read(nobody), OnScreen::Nobody, "{nobody:?}");
        }
        assert_eq!(
            refusal(&OnScreen::Locked, "PC-12").unwrap().1,
            "The machine is locked. Unlock it, then send the files again."
        );
        assert_eq!(
            refusal(&OnScreen::Nobody, "PC-12").unwrap().1,
            "Nobody is signed in on PC-12, so there is no Downloads folder to send to."
        );
        assert!(refusal(&OnScreen::Person { id: 1000 }, "PC-12").is_none());
    }
}
