//! Following seat0 on Linux (SPEC-DESKTOP 6.1): which session the physical
//! screen shows, read from logind once a second, and opening capture on it:
//! X11 for X sessions, KMS and uinput for everything else when the watch has
//! a [`ConsoleOpener`] (SPEC-CONSOLE-CAPTURE, table C1).
//!
//! [`LogindWatch`] runs `loginctl show-seat seat0` and `show-session` and
//! reads them with [`look_at`], a pure function: an X11 session with a
//! display is a screen (the sign-in screen for class `greeter`, else the
//! user's desktop, locked when `LockedHint` says so); Wayland, text consoles
//! and no session at all keep the browser waiting with a reason.
//!
//! Debug builds take two development overrides instead of logind:
//! [`SCREEN_FILE_OVERRIDE`] names a file that says which screen to show (so
//! an end-to-end test can switch screens), and [`DISPLAY_OVERRIDE`] with
//! [`XAUTHORITY_OVERRIDE`] fixes one nested X server. Release builds ignore
//! all three.

use super::kms::capturer::SharedSource;
use super::kms::SCREEN_OFF;
use super::x11_session::{find_xauthority, loginctl, parse_properties, X11Target};
use super::DesktopState;
use crate::follow::{console_state, screen_path, Look, ScreenPath, ScreenWatch};
use crate::Platform;
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::{Duration, Instant};

/// How long a screen KMS could not read waits before trying again.
pub const CONSOLE_RETRY: Duration = Duration::from_secs(10);

/// Starts the KMS reader for the screens X11 cannot show (the agent runs it
/// in its root `console-helper` process).
pub trait ConsoleOpener: Send {
    fn open(&mut self) -> Result<SharedSource, String>;
}

/// The KMS side of a watch: the opener, the running reader, and the last
/// failure (kept so it is not retried every second).
struct Console {
    opener: Box<dyn ConsoleOpener>,
    source: Option<SharedSource>,
    failure: Option<(String, String, Instant)>,
    /// The logind session the last look put on KMS, `None` while on X11.
    session: Option<String>,
}

/// Development and test override for the display (debug builds only).
pub const DISPLAY_OVERRIDE: &str = "BMUSTER_DESKTOP_DISPLAY";
/// Development and test override for the Xauthority file (debug builds only).
pub const XAUTHORITY_OVERRIDE: &str = "BMUSTER_DESKTOP_XAUTHORITY";
/// Development and test override (debug builds only): a file of `key=value`
/// lines read on every look. `display` and `xauthority` say where to
/// connect; `screen` is `sign-in`, `locked`, `desktop` or `unavailable`,
/// with `user` or `reason`. Changing `display` or `xauthority` switches
/// screens; changing only `screen` or `user` changes the state.
pub const SCREEN_FILE_OVERRIDE: &str = "BMUSTER_DESKTOP_SCREEN_FILE";

/// The X session a look found, kept so [`ScreenWatch::open`] can find its
/// Xauthority and connect.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct X11Seen {
    /// The logind session id (`None` for a development override).
    pub session: Option<String>,
    pub display: String,
    /// The account name and uid, for finding the Xauthority.
    pub user: String,
    pub uid: String,
    /// Set by a development override; logind sessions look it up.
    pub xauthority: Option<PathBuf>,
}

/// What seat0 shows: the look for the session, and the X session to open
/// when there is one.
pub fn look_at(
    active_session: &str,
    properties: &HashMap<String, String>,
) -> (Look, Option<X11Seen>) {
    let session = active_session.trim();
    let get = |key: &str| properties.get(key).map(String::as_str).unwrap_or("");
    let unavailable = |what: &str, reason: &str| {
        (
            Look {
                key: format!("{session}:{what}"),
                state: DesktopState::Unavailable {
                    reason: reason.to_string(),
                },
            },
            None,
        )
    };
    if get("State") == "closing" {
        return unavailable("closing", "The session on the screen is closing");
    }
    let greeter = get("Class") == "greeter";
    match get("Type") {
        "x11" => {}
        "wayland" if greeter => {
            return unavailable("wayland", "Wayland sign-in screen not supported yet")
        }
        "wayland" => return unavailable("wayland", "Wayland desktop not supported yet"),
        "tty" => return unavailable("tty", "Text console"),
        "" => return unavailable("unknown", "The session on the screen has no type"),
        other => {
            return unavailable(
                "other",
                &format!("The screen shows a {other} session, which BMuster cannot show"),
            )
        }
    }
    let display = get("Display");
    if display.is_empty() {
        return unavailable("no-display", "The X session on the screen has no display");
    }
    let user = get("Name");
    let named = (!user.is_empty()).then(|| user.to_string());
    let state = if greeter {
        DesktopState::SignIn
    } else if get("Class") == "lock-screen" || get("LockedHint") == "yes" {
        DesktopState::Locked { user: named }
    } else {
        DesktopState::Desktop { user: named }
    };
    (
        Look {
            key: format!("{session}:{display}"),
            state,
        },
        Some(X11Seen {
            session: Some(session.to_string()),
            display: display.to_string(),
            user: user.to_string(),
            uid: get("User").to_string(),
            xauthority: None,
        }),
    )
}

/// The look when seat0 has no active session (`show-seat` printed nothing).
fn no_session() -> Look {
    Look {
        key: "no-session".to_string(),
        state: DesktopState::Unavailable {
            reason: "No session is on the screen".to_string(),
        },
    }
}

/// Reads [`SCREEN_FILE_OVERRIDE`]'s `key=value` lines.
pub fn look_at_screen_file(text: &str) -> (Look, Option<X11Seen>) {
    let properties = parse_properties(text);
    let get = |key: &str| properties.get(key).map(String::as_str).unwrap_or("");
    let display = get("display");
    let xauthority = get("xauthority");
    let user = (!get("user").is_empty()).then(|| get("user").to_string());
    let state = match get("screen") {
        "sign-in" => DesktopState::SignIn,
        "locked" => DesktopState::Locked { user },
        "desktop" => DesktopState::Desktop { user },
        _ => DesktopState::Unavailable {
            reason: match get("reason") {
                "" => "No screen".to_string(),
                reason => reason.to_string(),
            },
        },
    };
    let key = format!("file:{display} {xauthority}");
    if matches!(state, DesktopState::Unavailable { .. }) || display.is_empty() {
        let state = match state {
            DesktopState::Unavailable { .. } => state,
            _ => DesktopState::Unavailable {
                reason: "The screen file names no display".to_string(),
            },
        };
        return (Look { key, state }, None);
    }
    let seen = X11Seen {
        session: None,
        display: display.to_string(),
        user: String::new(),
        uid: String::new(),
        xauthority: (!xauthority.is_empty()).then(|| PathBuf::from(xauthority)),
    };
    (Look { key, state }, Some(seen))
}

/// Seat0 through logind, or a development override in debug builds.
#[derive(Default)]
pub struct LogindWatch {
    seen: Option<X11Seen>,
    console: Option<Console>,
}

impl LogindWatch {
    /// X11 only: other screens wait with a reason.
    pub fn new() -> Self {
        LogindWatch::default()
    }

    /// X11, and KMS with uinput for every other screen.
    pub fn with_console(opener: Box<dyn ConsoleOpener>) -> Self {
        LogindWatch {
            seen: None,
            console: Some(Console {
                opener,
                source: None,
                failure: None,
                session: None,
            }),
        }
    }

    /// Why KMS could not show the current screen, while that stands.
    pub fn console_failure(&self) -> Option<&str> {
        let console = self.console.as_ref()?;
        let session = console.session.as_ref()?;
        console
            .failure
            .as_ref()
            .filter(|(failed, _, _)| failed == session)
            .map(|(_, reason, _)| reason.as_str())
    }

    /// The look for a screen on the KMS path: starts the reader if needed
    /// and asks it whether anything is lit.
    fn kms_look(&mut self, session: &str, properties: &HashMap<String, String>) -> Look {
        let get = |key: &str| properties.get(key).map(String::as_str).unwrap_or("");
        let unavailable = |key: String, reason: String| Look {
            key,
            state: DesktopState::Unavailable { reason },
        };
        let Some(console) = self.console.as_mut() else {
            return unavailable(
                format!("{session}:kms"),
                "Only X11 screens can be shown".into(),
            );
        };
        console.session = Some(session.to_string());
        if get("State") == "closing" {
            return unavailable(
                format!("{session}:closing"),
                "The session on the screen is closing".into(),
            );
        }
        if let Some((failed, reason, at)) = &console.failure {
            if failed == session && at.elapsed() < CONSOLE_RETRY {
                return unavailable(format!("kms-failed:{session}"), reason.clone());
            }
            console.failure = None;
        }
        let source = match &console.source {
            Some(source) => source.clone(),
            None => match console.opener.open() {
                Ok(source) => {
                    console.source = Some(source.clone());
                    source
                }
                Err(reason) => {
                    console.failure = Some((session.to_string(), reason.clone(), Instant::now()));
                    return unavailable(format!("kms-failed:{session}"), reason);
                }
            },
        };
        let displays = source.lock().unwrap_or_else(|p| p.into_inner()).displays();
        match displays {
            Err(error) => {
                console.source = None;
                console.failure = Some((session.to_string(), error.0.clone(), Instant::now()));
                unavailable(format!("kms-failed:{session}"), error.0)
            }
            Ok(list) if list.is_empty() => {
                unavailable(format!("kms-off:{session}"), SCREEN_OFF.to_string())
            }
            Ok(_) => Look {
                key: format!("kms:{session}"),
                state: console_state(get("Class"), get("LockedHint"), get("Name")),
            },
        }
    }

    /// Left the KMS path: stop the reader.
    fn leave_console(&mut self) {
        if let Some(console) = self.console.as_mut() {
            console.source = None;
            console.session = None;
        }
    }

    fn look_now(&mut self) -> (Look, Option<X11Seen>) {
        if cfg!(debug_assertions) {
            if let Some(path) = std::env::var_os(SCREEN_FILE_OVERRIDE) {
                return match std::fs::read_to_string(&path) {
                    Ok(text) => look_at_screen_file(&text),
                    Err(error) => (
                        Look {
                            key: "file:unreadable".to_string(),
                            state: DesktopState::Unavailable {
                                reason: format!(
                                    "Cannot read {SCREEN_FILE_OVERRIDE} {}: {error}",
                                    PathBuf::from(path).display()
                                ),
                            },
                        },
                        None,
                    ),
                };
            }
            if let Ok(display) = std::env::var(DISPLAY_OVERRIDE) {
                return (
                    Look {
                        key: format!("override:{display}"),
                        state: DesktopState::Desktop { user: None },
                    },
                    Some(X11Seen {
                        session: None,
                        display,
                        user: String::new(),
                        uid: String::new(),
                        xauthority: std::env::var_os(XAUTHORITY_OVERRIDE).map(PathBuf::from),
                    }),
                );
            }
        }
        let active = match active_session() {
            Ok(active) => active,
            Err(error) => {
                return (
                    Look {
                        key: "no-seat".to_string(),
                        state: DesktopState::Unavailable {
                            reason: format!("Cannot find the screen (seat0): {error}"),
                        },
                    },
                    None,
                )
            }
        };
        let session = active.trim();
        if session.is_empty() {
            if self.console.is_some() {
                return (self.kms_look("none", &HashMap::new()), None);
            }
            return (no_session(), None);
        }
        match session_properties(session) {
            Ok(properties) => {
                let kind = properties.get("Type").map(String::as_str).unwrap_or("");
                if self.console.is_some() && screen_path(kind) == ScreenPath::Kms {
                    return (self.kms_look(session, &properties), None);
                }
                self.leave_console();
                look_at(session, &properties)
            }
            // The session ended between the two calls: look again next time.
            Err(error) => (
                Look {
                    key: format!("{session}:gone"),
                    state: DesktopState::Unavailable {
                        reason: format!("The session on the screen went away: {error}"),
                    },
                },
                None,
            ),
        }
    }
}

/// seat0's active session id, empty when none, as logind says.
pub fn active_session() -> Result<String, String> {
    loginctl(&["show-seat", "seat0", "--property=ActiveSession", "--value"])
}

/// The properties of logind session `session` that the follower reads:
/// `Type`, `Class`, `Display`, `Name`, `User`, `State` and `LockedHint`.
pub fn session_properties(session: &str) -> Result<HashMap<String, String>, String> {
    loginctl(&[
        "show-session",
        session,
        "--property=Type",
        "--property=Class",
        "--property=Display",
        "--property=Name",
        "--property=User",
        "--property=State",
        "--property=LockedHint",
    ])
    .map(|text| parse_properties(&text))
}

impl ScreenWatch for LogindWatch {
    fn look(&mut self) -> Look {
        let (look, seen) = self.look_now();
        if self.seen.as_ref().map(|s| &s.display) != seen.as_ref().map(|s| &s.display) {
            if let Some(seen) = &seen {
                if seen.session.is_none() {
                    log::warn!(
                        "Desktop capture uses a development override: display {}",
                        seen.display
                    );
                }
            }
        }
        self.seen = seen;
        look
    }

    fn open(&mut self) -> Result<Platform, String> {
        if let Some(console) = self.console.as_mut() {
            if let (Some(session), Some(source)) = (&console.session, &console.source) {
                let opened =
                    crate::kms_platform(source.clone(), crate::input::uinput::Opener::system());
                if let Err(reason) = &opened {
                    console.failure = Some((session.clone(), reason.clone(), Instant::now()));
                    console.source = None;
                }
                return opened;
            }
        }
        let seen = self
            .seen
            .as_ref()
            .ok_or_else(|| "there is no X session on the screen".to_string())?;
        let xauthority = match (&seen.session, &seen.xauthority) {
            (_, Some(path)) => Some(path.clone()),
            (Some(session), None) => find_xauthority(session, &seen.display, &seen.user, &seen.uid),
            (None, None) => None,
        };
        crate::x11_platform(X11Target {
            display: seen.display.clone(),
            xauthority,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn look(session: &str, text: &str) -> (Look, Option<X11Seen>) {
        look_at(session, &parse_properties(text))
    }

    fn reason(look: &Look) -> &str {
        match &look.state {
            DesktopState::Unavailable { reason } => reason,
            other => panic!("expected unavailable, got {other:?}"),
        }
    }

    #[test]
    fn follow_loginctl_user_desktop_and_locked() {
        let (desktop, seen) = look(
            "4\n",
            "Type=x11\nClass=user\nDisplay=:0\nName=jack\nUser=1000\nState=active\nLockedHint=no\n",
        );
        assert_eq!(desktop.key, "4::0");
        assert_eq!(
            desktop.state,
            DesktopState::Desktop {
                user: Some("jack".into())
            }
        );
        let seen = seen.expect("an X session");
        assert_eq!(
            (seen.display.as_str(), seen.user.as_str(), seen.uid.as_str()),
            (":0", "jack", "1000")
        );
        assert_eq!(seen.session.as_deref(), Some("4"));

        let (locked, _) = look(
            "4",
            "Type=x11\nClass=user\nDisplay=:0\nName=jack\nState=active\nLockedHint=yes\n",
        );
        assert_eq!(locked.key, desktop.key, "locking keeps the same screen");
        assert_eq!(
            locked.state,
            DesktopState::Locked {
                user: Some("jack".into())
            }
        );
    }

    #[test]
    fn follow_loginctl_greeter_is_the_sign_in_screen() {
        let (greeter, seen) = look(
            "c1",
            "Type=x11\nClass=greeter\nDisplay=:0\nName=lightdm\nUser=115\nState=online\nLockedHint=no\n",
        );
        assert_eq!(greeter.state, DesktopState::SignIn);
        assert_eq!(greeter.key, "c1::0");
        assert_eq!(seen.map(|s| s.uid), Some("115".into()));
    }

    #[test]
    fn follow_loginctl_wayland_tty_and_odd_sessions_wait_with_a_reason() {
        let (wayland_greeter, seen) = look("c2", "Type=wayland\nClass=greeter\nDisplay=\n");
        assert_eq!(
            reason(&wayland_greeter),
            "Wayland sign-in screen not supported yet"
        );
        assert!(seen.is_none());
        let (wayland, _) = look("3", "Type=wayland\nClass=user\nName=jack\n");
        assert_eq!(reason(&wayland), "Wayland desktop not supported yet");
        let (tty, _) = look("5", "Type=tty\nClass=user\nName=root\n");
        assert_eq!(reason(&tty), "Text console");
        assert_eq!(tty.key, "5:tty");
        let (closing, _) = look("4", "Type=x11\nClass=user\nDisplay=:0\nState=closing\n");
        assert_eq!(reason(&closing), "The session on the screen is closing");
        let (no_display, _) = look("6", "Type=x11\nClass=user\nDisplay=\n");
        assert!(reason(&no_display).contains("no display"));
        let (mir, _) = look("7", "Type=mir\n");
        assert!(reason(&mir).contains("mir"));
        // Garbage from loginctl is no session type at all.
        let (garbage, _) = look("8", "this is not\nkey value output");
        assert!(reason(&garbage).contains("no type"));
        assert_eq!(reason(&no_session()), "No session is on the screen");
    }

    #[test]
    fn follow_loginctl_properties_parse_defensively() {
        let properties = parse_properties("Type = x11 \n\nDisplay=:1=odd\nName\n=nothing\n");
        assert_eq!(properties.get("Type").map(String::as_str), Some("x11"));
        assert_eq!(
            properties.get("Display").map(String::as_str),
            Some(":1=odd")
        );
        assert!(!properties.contains_key("Name"));
    }

    #[test]
    fn follow_screen_file_switches_and_states() {
        let (a, seen) =
            look_at_screen_file("display=:95\nxauthority=/tmp/a\nscreen=desktop\nuser=kim\n");
        assert_eq!(a.key, "file::95 /tmp/a");
        assert_eq!(
            a.state,
            DesktopState::Desktop {
                user: Some("kim".into())
            }
        );
        assert_eq!(
            seen.and_then(|s| s.xauthority),
            Some(PathBuf::from("/tmp/a"))
        );
        let (locked, _) =
            look_at_screen_file("display=:95\nxauthority=/tmp/a\nscreen=locked\nuser=kim\n");
        assert_eq!(locked.key, a.key);
        assert_eq!(
            locked.state,
            DesktopState::Locked {
                user: Some("kim".into())
            }
        );
        let (b, _) = look_at_screen_file("display=:96\nxauthority=/tmp/b\nscreen=sign-in\n");
        assert_ne!(b.key, a.key);
        assert_eq!(b.state, DesktopState::SignIn);
        let (none, seen) = look_at_screen_file("screen=unavailable\nreason=Text console\n");
        assert_eq!(reason(&none), "Text console");
        assert!(seen.is_none());
    }
}
