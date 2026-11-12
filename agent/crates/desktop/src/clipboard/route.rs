//! Whether a clipboard call on a KMS screen may reach the clipboard of
//! the session on it (SPEC-DESKTOP 21.10), from that logind session's
//! properties as they stand at the call.
//!
//! Only a person's own unlocked session is reached, and only by a helper
//! running as that person. The sign-in screen and a locked session are
//! refused: the greeter's clipboard is nobody's, and a locked session's
//! clipboard belongs to someone who is not at the machine to see it read
//! or changed.

use std::collections::HashMap;

/// The reason at the sign-in screen and while the session is locked.
pub const LOCKED: &str =
    "Copy and paste is not available while the machine is locked or at the sign-in screen.";

/// The first uid of a person's account (`UID_MIN` in login.defs).
const FIRST_UID: u32 = 1000;
/// `nobody`.
const NOBODY: u32 = 65534;

/// Where a clipboard call goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Route {
    /// The session of `uid`, through a helper running as them.
    User { uid: u32 },
    /// Nowhere, for this reason (for the person to read).
    Refused(String),
}

/// The route for a call, from logind's `Type`, `Class`, `User`, `State`
/// and `LockedHint` of the session on the screen (empty for none).
pub fn route(properties: &HashMap<String, String>) -> Route {
    let get = |key: &str| properties.get(key).map(String::as_str).unwrap_or("");
    let not_available = || Route::Refused(super::not_available().0);
    if get("State") == "closing" {
        return not_available();
    }
    match get("Class") {
        "greeter" | "lock-screen" => return Route::Refused(LOCKED.into()),
        "user" => {}
        _ => return not_available(),
    }
    if get("LockedHint") != "no" {
        // Locked, or logind could not say: refuse rather than guess.
        return Route::Refused(LOCKED.into());
    }
    match get("Type") {
        "wayland" | "x11" => {}
        _ => return not_available(),
    }
    match get("User").parse::<u32>() {
        Ok(uid) if uid >= FIRST_UID && uid != NOBODY => Route::User { uid },
        _ => not_available(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn route_for(text: &str) -> Route {
        route(
            &text
                .lines()
                .filter_map(|line| line.split_once('='))
                .map(|(key, value)| (key.to_string(), value.to_string()))
                .collect(),
        )
    }

    /// SPEC-DESKTOP C20: the person's unlocked Wayland (or X11) session is
    /// reached as them; locked, the greeter and logind's lock screen are
    /// refused with the locked reason; anything else is not available.
    #[test]
    fn c20_lock_and_sign_in_screen_are_refused() {
        let user = "Type=wayland\nClass=user\nUser=1000\nState=active\nLockedHint=no";
        assert_eq!(route_for(user), Route::User { uid: 1000 });
        assert_eq!(
            route_for("Type=x11\nClass=user\nUser=1001\nState=active\nLockedHint=no"),
            Route::User { uid: 1001 }
        );
        let locked = Route::Refused(LOCKED.into());
        assert_eq!(
            route_for("Type=wayland\nClass=user\nUser=1000\nState=active\nLockedHint=yes"),
            locked
        );
        // No LockedHint at all counts as locked.
        assert_eq!(
            route_for("Type=wayland\nClass=user\nUser=1000\nState=active"),
            locked
        );
        assert_eq!(
            route_for("Type=wayland\nClass=greeter\nUser=60578\nLockedHint=no"),
            locked
        );
        assert_eq!(
            route_for("Type=wayland\nClass=lock-screen\nUser=1000\nLockedHint=no"),
            locked
        );
        let not_available = Route::Refused(super::super::not_available().0);
        for other in [
            "",
            "Type=tty\nClass=user\nUser=1000\nLockedHint=no",
            "Type=wayland\nClass=user\nUser=0\nLockedHint=no",
            "Type=wayland\nClass=user\nUser=65534\nLockedHint=no",
            "Type=wayland\nClass=user\nUser=999\nLockedHint=no",
            "Type=wayland\nClass=user\nUser=1000\nState=closing\nLockedHint=no",
            "Type=wayland\nClass=background\nUser=1000\nLockedHint=no",
        ] {
            assert_eq!(route_for(other), not_available, "{other:?}");
        }
    }
}
