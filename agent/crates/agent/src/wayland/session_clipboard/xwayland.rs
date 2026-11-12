//! Route 2: the X11 `CLIPBOARD` selection of the session's X display,
//! through the agent's own X11 clipboard code (`x11rb`, `INCR`, the 1 MiB
//! cap). On a Wayland desktop that display is XWayland, and the compositor
//! bridges its selection to the Wayland clipboard both ways (mutter on
//! GNOME, KWin, wlroots compositors built with XWayland), so this reaches
//! GNOME, which has no data-control. GNOME starts XWayland on demand; the
//! first connection may start it.
//!
//! The display and its Xauthority come from the person's systemd user
//! manager (`systemctl --user show-environment`, where GNOME and Plasma
//! put `DISPLAY` and `XAUTHORITY`), else an Xauthority file the compositor
//! left in the runtime folder (`.mutter-Xwaylandauth.*` on GNOME,
//! `xauth_*` on Plasma). The helper reads them as the person, never root.

use super::routes::{Backend, Failure};
use bmuster_desktop::capture::x11_session::{connect, X11Target};
use bmuster_desktop::clipboard::x11::X11Clipboard;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// The X display of the session, or why there is none.
pub(crate) struct XWayland {
    target: Result<X11Target, String>,
    clipboard: Option<X11Clipboard>,
}

impl XWayland {
    pub(crate) fn new(target: Result<X11Target, String>) -> Self {
        Self {
            target,
            clipboard: None,
        }
    }

    /// The clipboard, connected on first use; a display that does not
    /// answer is a route the desktop does not offer.
    fn clipboard(&mut self) -> Result<&mut X11Clipboard, Failure> {
        let target = self
            .target
            .as_ref()
            .map_err(|reason| Failure::Unsupported(reason.clone()))?;
        if self.clipboard.is_none() {
            connect(target).map_err(|error| {
                Failure::Unsupported(format!("cannot connect to {}: {error}", target.display))
            })?;
            self.clipboard = Some(X11Clipboard::new(target.clone()));
        }
        self.clipboard
            .as_mut()
            .ok_or_else(|| Failure::Failed("The X clipboard did not open".into()))
    }
}

impl Backend for XWayland {
    fn name(&self) -> &'static str {
        "the X11 clipboard (XWayland)"
    }

    fn set(&mut self, text: &str) -> Result<(), Failure> {
        self.clipboard()?
            .set(text)
            .map_err(|error| Failure::Failed(error.0))
    }

    fn get(&mut self) -> Result<String, Failure> {
        self.clipboard()?
            .get()
            .map_err(|error| Failure::Failed(error.0))
    }
}

/// `KEY=value` lines of `systemctl --user show-environment`. Values with
/// special characters come quoted (`$'…'`); `DISPLAY` and the paths this
/// reads never have them, so a quoted value is left out.
pub(crate) fn parse_environment(text: &str) -> HashMap<String, String> {
    text.lines()
        .filter_map(|line| line.split_once('='))
        .filter(|(_, value)| !value.starts_with("$'"))
        .map(|(key, value)| (key.to_string(), value.to_string()))
        .collect()
}

/// The session's X display from its environment, with the Xauthority it
/// names, else the newest one of `found` (the runtime folder's
/// compositor-made Xauthority files with their change times).
pub(crate) fn target(
    environment: &HashMap<String, String>,
    found: &[(PathBuf, SystemTime)],
) -> Result<X11Target, String> {
    let display = environment
        .get("DISPLAY")
        .filter(|display| !display.is_empty())
        .ok_or_else(|| "the session has no X display (no XWayland)".to_string())?;
    let xauthority = match environment
        .get("XAUTHORITY")
        .filter(|path| !path.is_empty())
    {
        Some(path) => Some(PathBuf::from(path)),
        None => found
            .iter()
            .max_by_key(|(_, changed)| *changed)
            .map(|(path, _)| path.clone()),
    };
    Ok(X11Target {
        display: display.clone(),
        xauthority,
    })
}

/// The Xauthority files a compositor made in `runtime` for its XWayland.
pub(crate) fn xauthority_files(runtime: &Path) -> Vec<(PathBuf, SystemTime)> {
    let Ok(entries) = std::fs::read_dir(runtime) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .filter(|entry| {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            name.starts_with(".mutter-Xwaylandauth.") || name.starts_with("xauth_")
        })
        .filter_map(|entry| {
            let metadata = entry.metadata().ok()?;
            metadata
                .is_file()
                .then(|| Some((entry.path(), metadata.modified().ok()?)))
                .flatten()
        })
        .collect()
}
