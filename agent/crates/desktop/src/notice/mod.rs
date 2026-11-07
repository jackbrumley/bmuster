//! The notice at the machine (SPEC-DESKTOP 8, R11): while a desktop session
//! with `notice` on is open, the person at the screen sees
//! "<name> is connected (BMuster) · Disconnect". One bar lists every viewer;
//! Disconnect ends every desktop session on the machine at once with
//! `disconnected-at-machine`.
//!
//! [`show`] registers a viewer and returns a [`Notice`] that takes the name
//! off the bar when dropped. The bar itself is drawn by the platform module
//! on its own thread: an override-redirect window on X11. Windows draws no
//! bar yet (a layered window excluded from capture, SPEC-DESKTOP 8), so
//! there the notice only logs.

#[cfg(target_os = "linux")]
pub mod x11;

use crate::control::EndReason;
use crate::session::Incoming;
use std::sync::mpsc::Sender;
use std::sync::{Mutex, MutexGuard};

/// Where the bar is drawn: the X display on Linux; nothing yet on Windows.
#[cfg(target_os = "linux")]
pub type Target = crate::capture::x11_session::X11Target;
#[cfg(not(target_os = "linux"))]
pub type Target = ();

/// The bar's title, used to find it (tests) and shown by window lists.
pub const BAR_TITLE: &str = "BMuster notice";
/// The button's label.
pub const DISCONNECT_LABEL: &str = "Disconnect";

/// "Kim is connected (BMuster)", "Kim and Lee are connected (BMuster)",
/// "Kim, Lee and Sam are connected (BMuster)".
pub fn bar_text(names: &[String]) -> String {
    let who = match names {
        [] => return String::new(),
        [one] => return format!("{one} is connected (BMuster)"),
        [rest @ .., last] => format!("{} and {last}", rest.join(", ")),
    };
    format!("{who} are connected (BMuster)")
}

/// What a running bar is told.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BarCommand {
    Names(Vec<String>),
    Close,
}

struct Viewer {
    id: u64,
    name: String,
    end: Sender<Incoming>,
}

struct Board {
    next_id: u64,
    viewers: Vec<Viewer>,
    bar: Option<Sender<BarCommand>>,
}

static BOARD: Mutex<Board> = Mutex::new(Board {
    next_id: 1,
    viewers: Vec::new(),
    bar: None,
});

fn board() -> MutexGuard<'static, Board> {
    BOARD
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Board {
    fn names(&self) -> Vec<String> {
        self.viewers.iter().map(|v| v.name.clone()).collect()
    }

    /// Tells the bar the new names, or closes it when nobody is left.
    fn update_bar(&mut self) {
        let command = if self.viewers.is_empty() {
            BarCommand::Close
        } else {
            BarCommand::Names(self.names())
        };
        let closing = command == BarCommand::Close;
        if let Some(bar) = &self.bar {
            if bar.send(command).is_err() || closing {
                self.bar = None;
            }
        }
    }
}

/// A viewer's place on the bar; dropping it takes the name off.
#[derive(Debug)]
pub struct Notice {
    id: u64,
}

impl Drop for Notice {
    fn drop(&mut self) {
        let mut board = board();
        board.viewers.retain(|v| v.id != self.id);
        board.update_bar();
    }
}

/// Puts `name` on the bar at `target`, starting the bar if it is not up.
/// `end` is the session's own channel: Disconnect sends it
/// `End(DisconnectedAtMachine)`.
pub fn show(target: &Target, name: &str, end: Sender<Incoming>) -> Notice {
    let mut board = board();
    let id = board.next_id;
    board.next_id += 1;
    board.viewers.push(Viewer {
        id,
        name: name.to_string(),
        end,
    });
    if board.bar.is_none() {
        board.bar = start_bar(target, board.names());
    } else {
        board.update_bar();
    }
    Notice { id }
}

/// Disconnect at the machine: ends every desktop session. Returns how many
/// were told.
pub fn disconnect_all() -> usize {
    let board = board();
    log::warn!(
        "Disconnect pressed at the machine: ending {} desktop session(s)",
        board.viewers.len()
    );
    board
        .viewers
        .iter()
        .filter(|v| {
            v.end
                .send(Incoming::End(EndReason::DisconnectedAtMachine))
                .is_ok()
        })
        .count()
}

#[cfg(target_os = "linux")]
fn start_bar(target: &Target, names: Vec<String>) -> Option<Sender<BarCommand>> {
    match x11::start(target.clone(), names) {
        Ok(bar) => Some(bar),
        Err(error) => {
            log::error!("Could not show the notice bar: {error}");
            None
        }
    }
}

#[cfg(not(target_os = "linux"))]
fn start_bar(_target: &Target, names: Vec<String>) -> Option<Sender<BarCommand>> {
    log::warn!(
        "The notice bar is not built for this platform yet; {} is connected",
        names.join(", ")
    );
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn notice_bar_text_lists_every_viewer() {
        assert_eq!(bar_text(&[]), "");
        assert_eq!(bar_text(&["Kim".into()]), "Kim is connected (BMuster)");
        assert_eq!(
            bar_text(&["Kim".into(), "Lee".into()]),
            "Kim and Lee are connected (BMuster)"
        );
        assert_eq!(
            bar_text(&["Kim".into(), "Lee".into(), "Sam".into()]),
            "Kim, Lee and Sam are connected (BMuster)"
        );
    }

    #[test]
    fn notice_disconnect_ends_every_viewer_and_dropping_takes_names_off() {
        let (bar, commands) = mpsc::channel();
        let (kim_end, kim) = mpsc::channel();
        let (lee_end, lee) = mpsc::channel();
        let (first, second) = {
            let mut board = board();
            board.viewers.clear();
            board.bar = Some(bar);
            drop(board);
            // A bar is up already, so no X display is needed.
            (
                show(&test_target(), "Kim", kim_end),
                show(&test_target(), "Lee", lee_end),
            )
        };
        assert_eq!(
            commands.try_recv(),
            Ok(BarCommand::Names(vec!["Kim".into()]))
        );
        assert_eq!(
            commands.try_recv(),
            Ok(BarCommand::Names(vec!["Kim".into(), "Lee".into()]))
        );
        assert_eq!(disconnect_all(), 2);
        for inbox in [&kim, &lee] {
            assert_eq!(
                inbox.try_recv(),
                Ok(Incoming::End(EndReason::DisconnectedAtMachine))
            );
        }
        drop(first);
        assert_eq!(
            commands.try_recv(),
            Ok(BarCommand::Names(vec!["Lee".into()]))
        );
        drop(second);
        assert_eq!(commands.try_recv(), Ok(BarCommand::Close));
        assert!(board().bar.is_none());
    }

    #[cfg(target_os = "linux")]
    fn test_target() -> Target {
        crate::capture::x11_session::X11Target {
            display: ":99999".into(),
            xauthority: None,
        }
    }

    #[cfg(not(target_os = "linux"))]
    fn test_target() -> Target {}
}
