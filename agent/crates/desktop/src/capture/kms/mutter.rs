//! Asking mutter where the monitors are (SPEC-DESKTOP-ALL-SCREENS, Layout):
//! `org.gnome.Mutter.DisplayConfig.GetCurrentState` on the session bus of
//! the person whose desktop the screen shows.
//!
//! The agent is root; the call runs `busctl` as that person (their uid and
//! the group of their runtime folder, a clean environment, their bus
//! address), the way the agent's own checks reach a session bus, so root
//! never talks to a bus the person owns. The reply is only data: it moves
//! BMuster's picture and pointer about on that person's own screen, and
//! [`super::layout`] refuses anything out of range.

use super::layout::{parse_current_state, MutterState};
use std::collections::HashMap;
use std::io::Read as _;
use std::os::unix::fs::MetadataExt as _;
use std::os::unix::process::CommandExt as _;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const BUSCTL: &str = "/usr/bin/busctl";
/// How long mutter may take to answer.
const ANSWER_WITHIN: Duration = Duration::from_secs(2);
/// Largest reply read (a dozen monitors is a few kilobytes).
const MAX_REPLY: u64 = 1024 * 1024;

/// The first uid of a person's account (`UID_MIN` in login.defs).
const FIRST_UID: u32 = 1000;
/// `nobody`.
const NOBODY: u32 = 65534;

/// Whose compositor knows where the displays are on a KMS screen, from the
/// logind session's properties: the person's, when seat0 shows their
/// Wayland desktop (locked or not: GNOME's lock screen is the same mutter).
/// The greeter, a text console and no session at all keep the side-by-side
/// layout.
pub fn layout_owner(properties: &HashMap<String, String>) -> Result<u32, String> {
    let get = |key: &str| properties.get(key).map(String::as_str).unwrap_or("");
    match (get("Type"), get("Class")) {
        (_, "greeter") => return Err("the sign-in screen".into()),
        ("wayland", "user") => {}
        ("", _) => return Err("no session on the screen".into()),
        (kind, class) => return Err(format!("a {kind} {class} session")),
    }
    match get("User").parse::<u32>() {
        Ok(uid) if uid >= FIRST_UID && uid != NOBODY => Ok(uid),
        _ => Err(format!("the desktop of uid {:?}", get("User"))),
    }
}

/// Where a KMS capturer gets the compositor's layout from.
pub trait LayoutReader: Send {
    /// The current state, or why there is none.
    fn read(&mut self) -> Result<MutterState, String>;
}

/// No compositor to ask: the greeter, a text console, a session that is
/// not a person's Wayland desktop.
pub struct NoLayout(pub String);

impl LayoutReader for NoLayout {
    fn read(&mut self) -> Result<MutterState, String> {
        Err(self.0.clone())
    }
}

/// Mutter on `uid`'s session bus, through `busctl` as that user.
pub struct MutterReader {
    pub uid: u32,
}

impl LayoutReader for MutterReader {
    fn read(&mut self) -> Result<MutterState, String> {
        parse_current_state(&busctl_as(self.uid)?)
    }
}

/// The `busctl` arguments for the call.
pub fn arguments() -> [&'static str; 9] {
    [
        "--user",
        "--json=short",
        "--no-pager",
        "--timeout=2",
        "call",
        "org.gnome.Mutter.DisplayConfig",
        "/org/gnome/Mutter/DisplayConfig",
        "org.gnome.Mutter.DisplayConfig",
        "GetCurrentState",
    ]
}

fn busctl_as(uid: u32) -> Result<String, String> {
    if uid == 0 {
        return Err("the desktop belongs to root".into());
    }
    let runtime = format!("/run/user/{uid}");
    let folder = std::fs::metadata(&runtime).map_err(|e| format!("{runtime}: {e}"))?;
    if folder.uid() != uid {
        return Err(format!("{runtime} does not belong to uid {uid}"));
    }
    let mut child = Command::new(BUSCTL)
        .args(arguments())
        .env_clear()
        .env(
            "DBUS_SESSION_BUS_ADDRESS",
            format!("unix:path={runtime}/bus"),
        )
        .env("XDG_RUNTIME_DIR", &runtime)
        .uid(uid)
        .gid(folder.gid())
        .current_dir("/")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not run busctl: {e}"))?;
    let reader = |pipe: Option<Box<dyn std::io::Read + Send>>| {
        std::thread::spawn(move || {
            let mut bytes = Vec::new();
            if let Some(pipe) = pipe {
                let _ = pipe.take(MAX_REPLY).read_to_end(&mut bytes);
            }
            String::from_utf8_lossy(&bytes).trim().to_string()
        })
    };
    let stdout = reader(child.stdout.take().map(|p| Box::new(p) as Box<_>));
    let stderr = reader(child.stderr.take().map(|p| Box::new(p) as Box<_>));
    let until = Instant::now() + ANSWER_WITHIN + Duration::from_millis(500);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < until => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let out = stdout.join().unwrap_or_default();
    let err = stderr.join().unwrap_or_default();
    match status {
        Some(status) if status.success() => Ok(out),
        Some(status) => Err(format!(
            "busctl GetCurrentState exited with {status}: {err}"
        )),
        None => Err("mutter did not answer GetCurrentState in 2 s".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(kind: &str, class: &str, user: &str) -> HashMap<String, String> {
        [("Type", kind), ("Class", class), ("User", user)]
            .into_iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn mutter_is_asked_only_on_a_persons_wayland_desktop() {
        assert_eq!(layout_owner(&session("wayland", "user", "1000")), Ok(1000));
        assert_eq!(
            layout_owner(&session("wayland", "greeter", "42")),
            Err("the sign-in screen".into())
        );
        assert_eq!(
            layout_owner(&session("tty", "user", "1000")),
            Err("a tty user session".into())
        );
        assert_eq!(
            layout_owner(&HashMap::new()),
            Err("no session on the screen".into())
        );
        for uid in ["0", "999", "65534", "jack"] {
            assert!(
                layout_owner(&session("wayland", "user", uid)).is_err(),
                "{uid}"
            );
        }
    }

    #[test]
    fn mutter_reader_refuses_root_and_a_missing_runtime_folder() {
        assert_eq!(
            MutterReader { uid: 0 }.read(),
            Err("the desktop belongs to root".into())
        );
        let missing = MutterReader { uid: 4_000_000 }.read().unwrap_err();
        assert!(missing.starts_with("/run/user/4000000: "), "{missing}");
        assert_eq!(
            NoLayout("the greeter".into()).read(),
            Err("the greeter".into())
        );
        assert_eq!(arguments()[8], "GetCurrentState");
    }

    /// Run by hand in a desktop session: asks this user's own bus. On GNOME
    /// it reads the layout; elsewhere busctl's own error comes back.
    #[test]
    #[ignore]
    fn mutter_reader_asks_this_users_session_bus() {
        // SAFETY: getuid has no arguments and cannot fail.
        let uid = unsafe { libc::getuid() };
        match (MutterReader { uid }).read() {
            Ok(state) => assert!(!state.logical.is_empty()),
            Err(reason) => assert!(
                reason.starts_with("busctl GetCurrentState exited"),
                "{reason}"
            ),
        }
    }
}
