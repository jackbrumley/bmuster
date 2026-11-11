//! Asking the desktop's compositor where the monitors are
//! (SPEC-DESKTOP-ALL-SCREENS, Layout): mutter on GNOME ([`super::mutter`]),
//! KWin on KDE Plasma ([`super::kwin`]), on the session bus of the person
//! whose desktop the screen shows.
//!
//! The agent is root; every call runs `busctl` as that person (their uid
//! and the group of their runtime folder, a clean environment, their bus
//! address), the way the agent's own checks reach a session bus, so root
//! never talks to a bus the person owns. Every call is fixed in the code
//! (nothing from the browser). Replies are only data: they move BMuster's
//! picture and pointer about on that person's own screen, and
//! [`super::layout`] refuses anything out of range.

use super::layout::{Compositor, CompositorLayout};
use super::{kwin, mutter};
use serde_json::Value;
use std::collections::HashMap;
use std::io::Read as _;
use std::os::unix::fs::MetadataExt as _;
use std::os::unix::process::CommandExt as _;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const BUSCTL: &str = "/usr/bin/busctl";
/// How long the compositor may take to answer.
const ANSWER_WITHIN: Duration = Duration::from_secs(2);
/// Largest reply read (a dozen monitors is a few kilobytes; KWin's
/// support information, tens of kilobytes).
const MAX_REPLY: u64 = 1024 * 1024;

/// The first uid of a person's account (`UID_MIN` in login.defs).
const FIRST_UID: u32 = 1000;
/// `nobody`.
const NOBODY: u32 = 65534;

/// Whose compositor to ask, and which compositor it is when logind's
/// `Desktop` names it (`None`: ask the bus which one is there).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LayoutOwner {
    pub uid: u32,
    pub compositor: Option<Compositor>,
}

/// Whose compositor knows where the displays are on a KMS screen, from the
/// logind session's properties: the person's, when seat0 shows their
/// Wayland desktop (locked or not: GNOME's and Plasma's lock screens are
/// drawn by the same compositor). The greeter, a text console and no
/// session at all keep the side-by-side layout.
pub fn layout_owner(properties: &HashMap<String, String>) -> Result<LayoutOwner, String> {
    let get = |key: &str| properties.get(key).map(String::as_str).unwrap_or("");
    match (get("Type"), get("Class")) {
        (_, "greeter") => return Err("the sign-in screen".into()),
        ("wayland", "user") => {}
        ("", _) => return Err("no session on the screen".into()),
        (kind, class) => return Err(format!("a {kind} {class} session")),
    }
    match get("User").parse::<u32>() {
        Ok(uid) if uid >= FIRST_UID && uid != NOBODY => Ok(LayoutOwner {
            uid,
            compositor: compositor_named(get("Desktop")),
        }),
        _ => Err(format!("the desktop of uid {:?}", get("User"))),
    }
}

/// The compositor logind's `Desktop` (the display manager's
/// `XDG_SESSION_DESKTOP`) names: `KDE` or `plasma…` is KWin, `gnome…` is
/// mutter. Anything else (`ubuntu`, or empty for a session started by
/// hand) is found out on the bus.
pub fn compositor_named(desktop: &str) -> Option<Compositor> {
    let desktop = desktop.to_ascii_lowercase();
    let parts = || desktop.split([':', ';']).map(str::trim);
    if parts().any(|d| d == "kde" || d.starts_with("plasma")) {
        Some(Compositor::KWin)
    } else if parts().any(|d| d.starts_with("gnome")) {
        Some(Compositor::Mutter)
    } else {
        None
    }
}

/// Where a KMS capturer gets the compositor's layout from.
pub trait LayoutReader: Send {
    /// The current layout, or why there is none.
    fn read(&mut self) -> Result<CompositorLayout, String>;
}

/// No compositor to ask: the greeter, a text console, a session that is
/// not a person's Wayland desktop.
pub struct NoLayout(pub String);

impl LayoutReader for NoLayout {
    fn read(&mut self) -> Result<CompositorLayout, String> {
        Err(self.0.clone())
    }
}

/// One method call on the session bus, fixed in the code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Call {
    pub destination: &'static str,
    pub path: &'static str,
    pub interface: &'static str,
    pub method: &'static str,
    /// The D-Bus signature and arguments, as busctl takes them.
    pub arguments: &'static [&'static str],
}

impl Call {
    /// The whole `busctl` command line after the program.
    pub fn busctl_arguments(&self) -> Vec<&'static str> {
        let mut all = vec![
            "--user",
            "--json=short",
            "--no-pager",
            "--timeout=2",
            "call",
            self.destination,
            self.path,
            self.interface,
            self.method,
        ];
        all.extend_from_slice(self.arguments);
        all
    }
}

/// Asks the bus whether a name has an owner; `arguments` is
/// `["s", name]`.
pub const fn name_has_owner(arguments: &'static [&'static str]) -> Call {
    Call {
        destination: "org.freedesktop.DBus",
        path: "/org/freedesktop/DBus",
        interface: "org.freedesktop.DBus",
        method: "NameHasOwner",
        arguments,
    }
}

/// Reads `busctl --json=short` output of `NameHasOwner`.
pub fn has_owner(json: &str) -> Result<bool, String> {
    serde_json::from_str::<Value>(json)
        .ok()
        .and_then(|value| value.get("data")?.get(0)?.as_bool())
        .ok_or_else(|| "NameHasOwner reply is not a yes or no".into())
}

/// Makes a call as this uid and gives back busctl's JSON; the real one is
/// [`busctl_as`], tests pass their own.
pub type Bus = fn(u32, &Call) -> Result<String, String>;

/// The owner's compositor on their session bus.
pub struct CompositorReader {
    owner: LayoutOwner,
    bus: Bus,
}

impl CompositorReader {
    pub fn new(owner: LayoutOwner) -> Self {
        CompositorReader::with(owner, busctl_as)
    }

    pub fn with(owner: LayoutOwner, bus: Bus) -> Self {
        CompositorReader { owner, bus }
    }

    /// The compositor logind named, else the one whose bus name has an
    /// owner (kept once found).
    fn compositor(&mut self) -> Result<Compositor, String> {
        if let Some(known) = self.owner.compositor {
            return Ok(known);
        }
        for (compositor, call) in [
            (Compositor::Mutter, mutter::IS_THERE),
            (Compositor::KWin, kwin::IS_THERE),
        ] {
            if has_owner(&(self.bus)(self.owner.uid, &call)?)? {
                self.owner.compositor = Some(compositor);
                return Ok(compositor);
            }
        }
        Err("neither mutter nor KWin is on the session bus".into())
    }
}

impl LayoutReader for CompositorReader {
    fn read(&mut self) -> Result<CompositorLayout, String> {
        let uid = self.owner.uid;
        match self.compositor()? {
            Compositor::Mutter => mutter::parse_current_state(&(self.bus)(uid, &mutter::CALL)?),
            Compositor::KWin => kwin::parse_support_information(&(self.bus)(uid, &kwin::CALL)?),
        }
    }
}

/// Makes `call` with `busctl` as `uid`, on that user's session bus.
pub fn busctl_as(uid: u32, call: &Call) -> Result<String, String> {
    if uid == 0 {
        return Err("the desktop belongs to root".into());
    }
    let method = call.method;
    let runtime = format!("/run/user/{uid}");
    let folder = std::fs::metadata(&runtime).map_err(|e| format!("{runtime}: {e}"))?;
    if folder.uid() != uid {
        return Err(format!("{runtime} does not belong to uid {uid}"));
    }
    let mut child = Command::new(BUSCTL)
        .args(call.busctl_arguments())
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
        Some(status) => Err(format!("busctl {method} exited with {status}: {err}")),
        None => Err(format!("no answer to {method} in 2 s")),
    }
}

#[cfg(test)]
#[path = "compositor_tests.rs"]
mod tests;
