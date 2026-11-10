//! Following the screen on Windows (SPEC-DESKTOP 6.2): the desktop helper
//! runs as SYSTEM in the console session, and the screen there is the input
//! desktop, Default (someone's programs) or Winlogon (the sign-in screen,
//! the lock screen, a UAC prompt). [`InputDesktopWatch::look`] moves the
//! session's thread to the input desktop and says what it shows; the
//! following session ([`crate::session`]) reopens capture and input when
//! the desktop's name changes. The capturer also notices a switch on its
//! next tick ([`super::windows`]), so a lock or a UAC prompt is followed at
//! once rather than at the next look.

use crate::capture::DesktopState;
use crate::follow::{Look, ScreenWatch};
use crate::winsession::{console, input_desktop, names};
use crate::Platform;

/// The input desktop of the helper's console session.
#[derive(Debug, Default)]
pub struct InputDesktopWatch;

/// What the desktop named `desktop` shows.
pub fn state_for(desktop: &str) -> DesktopState {
    let session = console::current_session();
    let user = session.and_then(console::session_user);
    let consent = desktop.eq_ignore_ascii_case("Winlogon")
        && user.is_some()
        && session.is_some_and(|s| !console::processes_in_session("consent.exe", s).is_empty());
    names::desktop_state(desktop, user, consent)
}

impl ScreenWatch for InputDesktopWatch {
    fn look(&mut self) -> Look {
        match input_desktop::follow_input_desktop() {
            Ok((desktop, _)) => Look {
                dark: false,
                state: state_for(&desktop),
                key: desktop,
            },
            Err(error) => Look {
                dark: false,
                key: String::new(),
                state: DesktopState::Unavailable {
                    reason: format!("The agent cannot reach the screen: {error}"),
                },
            },
        }
    }

    fn open(&mut self) -> Result<Platform, String> {
        crate::open_platform()
    }

    fn waker(&mut self) -> Result<Box<dyn crate::follow::Waker>, String> {
        Ok(Box::new(crate::input::windows::SendInputWaker))
    }
}
