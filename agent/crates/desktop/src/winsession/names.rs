//! Names Windows gives that BMuster shows: the console user, and where the
//! console is (sign-in screen, locked, a UAC prompt, someone's desktop).

use crate::capture::DesktopState;

/// The console user as Overview shows it: `jack` for a local or Microsoft
/// account (its domain is this computer), `CORP\jack` for a domain account.
/// `None` when nobody is signed in (the user name is empty).
pub fn account_label(user: &str, domain: &str, computer: &str) -> Option<String> {
    let user = user.trim();
    if user.is_empty() {
        return None;
    }
    let domain = domain.trim();
    if domain.is_empty() || domain.eq_ignore_ascii_case(computer.trim()) {
        Some(user.to_string())
    } else {
        Some(format!("{domain}\\{user}"))
    }
}

/// What the screen shows, for the `state` message: the input desktop
/// `desktop` (Windows' own names: `Default`, `Winlogon`, …), the session's
/// user, and whether the UAC prompt (`consent.exe`) runs in the session.
///
/// The lock screen, the sign-in screen and the UAC prompt all use the
/// Winlogon desktop: nobody signed in means the sign-in screen; a UAC prompt
/// sits over the user's own desktop; otherwise the session is locked.
pub fn desktop_state(desktop: &str, user: Option<String>, consent_running: bool) -> DesktopState {
    if desktop.eq_ignore_ascii_case("Default") {
        return DesktopState::Desktop { user };
    }
    match user {
        None => DesktopState::SignIn,
        Some(_) if consent_running => DesktopState::Desktop { user },
        Some(_) => DesktopState::Locked { user },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn console_user_label_drops_the_local_domain() {
        assert_eq!(
            account_label("jack", "DESKTOP-7K2", "DESKTOP-7K2"),
            Some("jack".into())
        );
        assert_eq!(
            account_label("jack", "desktop-7k2", "DESKTOP-7K2"),
            Some("jack".into())
        );
        assert_eq!(
            account_label("jack", "CORP", "DESKTOP-7K2"),
            Some("CORP\\jack".into())
        );
        assert_eq!(account_label("jack", "", "PC"), Some("jack".into()));
        assert_eq!(account_label("", "DESKTOP-7K2", "DESKTOP-7K2"), None);
    }

    #[test]
    fn desktop_state_tells_sign_in_lock_uac_and_desktop_apart() {
        let jack = || Some("jack".to_string());
        assert_eq!(desktop_state("Winlogon", None, false), DesktopState::SignIn);
        assert_eq!(
            desktop_state("Winlogon", jack(), false),
            DesktopState::Locked { user: jack() }
        );
        assert_eq!(
            desktop_state("Winlogon", jack(), true),
            DesktopState::Desktop { user: jack() }
        );
        assert_eq!(
            desktop_state("Default", jack(), false),
            DesktopState::Desktop { user: jack() }
        );
        assert_eq!(
            desktop_state("default", None, false),
            DesktopState::Desktop { user: None }
        );
        assert_eq!(
            desktop_state("Screen-saver", jack(), false),
            DesktopState::Locked { user: jack() }
        );
    }
}
