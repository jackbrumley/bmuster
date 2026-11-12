//! The clipboard helper's routes to the session's clipboard, tried in
//! order (SPEC-DESKTOP 21.10): the first that the desktop supports serves
//! the call. Only standard protocols, nothing desktop-specific:
//!
//! 1. Wayland data-control ([`super::data_control`]): KWin, wlroots
//!    compositors (Sway, Hyprland, river, labwc, Wayfire), COSMIC, niri.
//! 2. The X11 `CLIPBOARD` selection ([`super::xwayland`]) of the session's
//!    XWayland, which the compositor bridges to its Wayland clipboard
//!    (GNOME, which has no data-control), or of a plain X server.

use bmuster_desktop::control::MAX_CLIPBOARD_BYTES;
use std::io::Read as _;
use std::os::fd::{AsRawFd as _, OwnedFd};
use std::time::{Duration, Instant};

/// Why a route did not serve a call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Failure {
    /// The desktop does not offer this route: try the next.
    Unsupported(String),
    /// The route is there but the call failed: the answer.
    Failed(String),
}

/// One route to the session's clipboard.
pub(crate) trait Backend: Send {
    /// Its name in the agent log.
    fn name(&self) -> &'static str;
    fn set(&mut self, text: &str) -> Result<(), Failure>;
    /// The clipboard's text; empty when it holds none.
    fn get(&mut self) -> Result<String, Failure>;
}

/// The routes in order, and which one served last.
pub(crate) struct Backends {
    routes: Vec<Box<dyn Backend>>,
    served: Option<&'static str>,
    reported: Option<&'static str>,
}

impl Backends {
    pub(crate) fn new(routes: Vec<Box<dyn Backend>>) -> Self {
        Self {
            routes,
            served: None,
            reported: None,
        }
    }

    /// `call` on the first route that supports it.
    fn run<T>(
        &mut self,
        mut call: impl FnMut(&mut dyn Backend) -> Result<T, Failure>,
    ) -> Result<T, String> {
        let mut missing = Vec::new();
        for route in &mut self.routes {
            match call(route.as_mut()) {
                Ok(value) => {
                    self.served = Some(route.name());
                    return Ok(value);
                }
                Err(Failure::Failed(reason)) => {
                    self.served = Some(route.name());
                    return Err(reason);
                }
                Err(Failure::Unsupported(reason)) => {
                    missing.push(format!("{}: {reason}", route.name()))
                }
            }
        }
        Err(format!(
            "Copy and paste is not available on this desktop ({}).",
            missing.join("; ")
        ))
    }

    pub(crate) fn set(&mut self, text: &str) -> Result<(), String> {
        if text.len() > MAX_CLIPBOARD_BYTES {
            return Err("The clipboard text is over 1 MB".into());
        }
        self.run(|route| route.set(text))
    }

    pub(crate) fn get(&mut self) -> Result<String, String> {
        self.run(|route| route.get())
    }

    /// The route that served the last call, once each time it changes.
    pub(crate) fn changed(&mut self) -> Option<&'static str> {
        if self.served == self.reported {
            return None;
        }
        self.reported = self.served;
        self.served
    }
}

/// The text types a pull asks for, best first: UTF-8 ones, then plain
/// text, then X11's Latin-1 `STRING`, then `TEXT`.
pub(crate) const TEXT_TYPES: [&str; 5] = [
    "text/plain;charset=utf-8",
    "UTF8_STRING",
    "text/plain",
    "STRING",
    "TEXT",
];

/// The best text type among `offered`, spelt as the owner spelt it (types
/// compare without regard to case); `None` when nothing is text.
pub(crate) fn text_type(offered: &[String]) -> Option<&String> {
    TEXT_TYPES.iter().find_map(|wanted| {
        offered
            .iter()
            .find(|offered| offered.eq_ignore_ascii_case(wanted))
    })
}

/// The text of `bytes` in `mime_type`: Latin-1 for `STRING`, else UTF-8
/// with invalid sequences replaced.
pub(crate) fn decode(mime_type: &str, bytes: &[u8]) -> String {
    if mime_type.eq_ignore_ascii_case("STRING") {
        bytes.iter().map(|&byte| char::from(byte)).collect()
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

/// Everything until the writer closes `fd`, within `wait`; more than
/// `cap` bytes fails, and so does a writer that is still going at the end.
pub(crate) fn read_within(fd: OwnedFd, cap: usize, wait: Duration) -> Result<Vec<u8>, String> {
    let deadline = Instant::now() + wait;
    let mut file = std::fs::File::from(fd);
    let mut bytes = Vec::new();
    let mut chunk = vec![0; 64 * 1024];
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(format!(
                "The machine's clipboard did not answer within {} s",
                wait.as_secs()
            ));
        }
        let mut poll = libc::pollfd {
            fd: file.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        let millis = libc::c_int::try_from(left.as_millis().max(1)).unwrap_or(libc::c_int::MAX);
        // SAFETY: one pollfd for a descriptor `file` keeps open.
        let ready = unsafe { libc::poll(&mut poll, 1, millis) };
        if ready < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return Err(format!("Reading the clipboard failed: {error}"));
        }
        if ready == 0 {
            continue;
        }
        // Readable or hung up: a read now does not block.
        match file.read(&mut chunk) {
            Ok(0) => return Ok(bytes),
            Ok(count) => {
                if bytes.len() + count > cap {
                    return Err(bmuster_desktop::clipboard::too_large().0);
                }
                bytes.extend_from_slice(&chunk[..count]);
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(error) => return Err(format!("Reading the clipboard failed: {error}")),
        }
    }
}
