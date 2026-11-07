//! Names Windows gives that BMuster shows: the console user, and where the
//! console is (sign-in screen, locked, a UAC prompt, someone's desktop).

use crate::capture::{DesktopKind, DesktopState};

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

/// The `state` message for the input desktop named `desktop` (Windows'
/// own names: `Default`, `Winlogon`, …), the session's user, and whether the
/// UAC prompt (`consent.exe`) runs in the session.
///
/// The lock screen, the sign-in screen and the UAC prompt all use the
/// Winlogon desktop: nobody signed in means the sign-in screen; a UAC prompt
/// means the secure desktop; otherwise the session is locked.
pub fn desktop_state(desktop: &str, user: Option<String>, consent_running: bool) -> DesktopState {
    if desktop.eq_ignore_ascii_case("Default") {
        return DesktopState {
            desktop: DesktopKind::Default,
            locked: false,
            signed_in_user: user,
        };
    }
    let winlogon = desktop.eq_ignore_ascii_case("Winlogon");
    match (&user, winlogon && !consent_running) {
        (None, true) => DesktopState {
            desktop: DesktopKind::Winlogon,
            locked: false,
            signed_in_user: None,
        },
        (Some(_), true) => DesktopState {
            desktop: DesktopKind::Winlogon,
            locked: true,
            signed_in_user: user,
        },
        (_, false) => DesktopState {
            desktop: DesktopKind::Secure,
            locked: false,
            signed_in_user: user,
        },
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
        assert_eq!(
            desktop_state("Winlogon", None, false),
            DesktopState {
                desktop: DesktopKind::Winlogon,
                locked: false,
                signed_in_user: None
            }
        );
        assert_eq!(
            desktop_state("Winlogon", jack(), false),
            DesktopState {
                desktop: DesktopKind::Winlogon,
                locked: true,
                signed_in_user: jack()
            }
        );
        assert_eq!(
            desktop_state("Winlogon", jack(), true),
            DesktopState {
                desktop: DesktopKind::Secure,
                locked: false,
                signed_in_user: jack()
            }
        );
        assert_eq!(
            desktop_state("Default", jack(), false),
            DesktopState {
                desktop: DesktopKind::Default,
                locked: false,
                signed_in_user: jack()
            }
        );
        assert_eq!(
            desktop_state("default", None, false).desktop,
            DesktopKind::Default
        );
        assert_eq!(
            desktop_state("Screen-saver", jack(), false).desktop,
            DesktopKind::Secure
        );
    }
}
