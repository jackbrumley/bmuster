//! The notice at the machine (SPEC-DESKTOP 8, R11): while a desktop session
//! with `notice` on is open, the person at the screen sees
//! "<name> is connected (BMuster) · Disconnect". One bar lists every viewer;
//! Disconnect ends every desktop session on the machine at once with
//! `disconnected-at-machine`.
//!
//! [`show`] registers a viewer and returns a [`Notice`] that takes the name
//! off the bar when dropped. The bar itself is drawn by the platform module
//! on its own thread: an override-redirect window on X11, a topmost tool
//! window kept out of the capture on Windows (drawn by the desktop helper,
//! on the user's desktop only). A session that follows the screen moves the
//! bar with [`keep_on`] when the screen changes, and puts it back if its X
//! server went away.

#[cfg(windows)]
pub mod windows;
#[cfg(target_os = "linux")]
pub mod x11;

use crate::control::EndReason;
use crate::session::Incoming;
use std::sync::mpsc::Sender;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

/// Where the bar is drawn: the X display on Linux.
#[cfg(target_os = "linux")]
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    X11(crate::capture::x11_session::X11Target),
    Portal,
}
#[cfg(target_os = "linux")]
impl From<crate::capture::x11_session::X11Target> for Target {
    fn from(target: crate::capture::x11_session::X11Target) -> Self {
        Self::X11(target)
    }
}
/// Elsewhere one place: the helper's own (Default) desktop on Windows.
#[cfg(not(target_os = "linux"))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target;

/// The bar's title, used to find it (tests) and shown by window lists.
pub const BAR_TITLE: &str = "BMuster notice";
/// The button's label.
pub const DISCONNECT_LABEL: &str = "Disconnect";
/// How long a screen the bar could not open on is left before trying again.
const RETRY: Duration = Duration::from_secs(10);

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
    /// Nothing to do: sending it tells whether the bar is still up.
    Check,
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
    /// The screen the bar is on, or goes on once someone is connected.
    screen: Option<Target>,
    /// When the bar last failed to start on `screen`.
    failed_at: Option<Instant>,
}

static BOARD: Mutex<Board> = Mutex::new(Board {
    next_id: 1,
    viewers: Vec::new(),
    bar: None,
    screen: None,
    failed_at: None,
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

    /// Another screen (or none): the bar leaves the old one.
    fn set_screen(&mut self, screen: Option<Target>) {
        if self.screen != screen {
            if let Some(bar) = self.bar.take() {
                let _ = bar.send(BarCommand::Close);
            }
            self.screen = screen;
            self.failed_at = None;
        }
    }

    /// Starts the bar on the screen when someone is connected and it is not
    /// up (never started, failed, or its X server went away).
    fn ensure_bar(&mut self) {
        if self.viewers.is_empty() {
            return;
        }
        if self
            .bar
            .as_ref()
            .is_some_and(|bar| bar.send(BarCommand::Check).is_ok())
        {
            return;
        }
        self.bar = None;
        let Some(screen) = self.screen.clone() else {
            return;
        };
        #[cfg(target_os = "linux")]
        if matches!(screen, Target::Portal) {
            return;
        }
        if self.failed_at.is_some_and(|at| at.elapsed() < RETRY) {
            return;
        }
        self.bar = start_bar(&screen, self.names());
        self.failed_at = self.bar.is_none().then(Instant::now);
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

/// Puts `name` on the bar, starting the bar if it is not up. The bar goes
/// on `target`, or with `None` on the screen a following session last
/// placed it on with [`keep_on`]. `end` is the session's own channel:
/// Disconnect sends it `End(DisconnectedAtMachine)`.
pub fn show(target: Option<&Target>, name: &str, end: Sender<Incoming>) -> Notice {
    let mut board = board();
    let id = board.next_id;
    board.next_id += 1;
    board.viewers.push(Viewer {
        id,
        name: name.to_string(),
        end,
    });
    if let Some(target) = target {
        board.set_screen(Some(target.clone()));
    }
    if board.bar.is_some() {
        board.update_bar();
    }
    board.ensure_bar();
    Notice { id }
}

/// The screen is now `screen` (`None`: nothing to show the bar on). The bar
/// moves there, and comes back if its X server went away. Following
/// sessions call this whenever they look at the screen.
pub fn keep_on(screen: Option<&Target>) {
    let mut board = board();
    board.set_screen(screen.cloned());
    board.ensure_bar();
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
    let Target::X11(target) = target else {
        return None;
    };
    match x11::start(target.clone(), names) {
        Ok(bar) => Some(bar),
        Err(error) => {
            log::error!("Could not show the notice bar: {error}");
            None
        }
    }
}

#[cfg(windows)]
fn start_bar(_target: &Target, names: Vec<String>) -> Option<Sender<BarCommand>> {
    match windows::start(names) {
        Ok(bar) => Some(bar),
        Err(error) => {
            log::error!("Could not show the notice bar: {error}");
            None
        }
    }
}

#[cfg(not(any(target_os = "linux", windows)))]
fn start_bar(_target: &Target, names: Vec<String>) -> Option<Sender<BarCommand>> {
    log::warn!(
        "The notice bar is not built for this platform yet; {} is connected",
        names.join(", ")
    );
    None
}

/// The board is global: tests that touch it (these, and the following
/// session's) take turns.
#[cfg(test)]
pub(crate) fn test_turn() -> MutexGuard<'static, ()> {
    static TURN: Mutex<()> = Mutex::new(());
    TURN.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
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
        let _turn = test_turn();
        let (bar, commands) = mpsc::channel();
        let (kim_end, kim) = mpsc::channel();
        let (lee_end, lee) = mpsc::channel();
        let (first, second) = {
            let mut board = board();
            board.viewers.clear();
            board.bar = Some(bar);
            board.screen = Some(test_target());
            drop(board);
            // A bar is up already on this screen, so no X display is needed.
            (
                show(Some(&test_target()), "Kim", kim_end),
                show(None, "Lee", lee_end),
            )
        };
        let next = || {
            commands
                .try_iter()
                .find(|command| *command != BarCommand::Check)
        };
        assert_eq!(next(), Some(BarCommand::Names(vec!["Kim".into()])));
        assert_eq!(
            next(),
            Some(BarCommand::Names(vec!["Kim".into(), "Lee".into()]))
        );
        assert_eq!(disconnect_all(), 2);
        for inbox in [&kim, &lee] {
            assert_eq!(
                inbox.try_recv(),
                Ok(Incoming::End(EndReason::DisconnectedAtMachine))
            );
        }
        drop(first);
        assert_eq!(next(), Some(BarCommand::Names(vec!["Lee".into()])));
        drop(second);
        assert_eq!(next(), Some(BarCommand::Close));
        assert!(board().bar.is_none());
    }

    #[test]
    fn notice_keep_on_moves_the_bar_to_another_screen() {
        let _turn = test_turn();
        let (bar, commands) = mpsc::channel();
        let (end, _inbox) = mpsc::channel();
        {
            let mut board = board();
            board.viewers.clear();
            board.bar = Some(bar);
            board.screen = Some(test_target());
        }
        let shown = show(None, "Kim", end);
        keep_on(Some(&test_target()));
        assert!(board().bar.is_some(), "same screen: the bar stays");
        // No screen (a Wayland greeter): the old bar closes.
        keep_on(None);
        assert_eq!(
            commands.try_iter().find(|c| *c != BarCommand::Check),
            Some(BarCommand::Names(vec!["Kim".into()]))
        );
        assert_eq!(
            commands.try_iter().find(|c| *c != BarCommand::Check),
            Some(BarCommand::Close)
        );
        assert!(board().bar.is_none());
        assert_eq!(board().screen, None);
        drop(shown);
    }

    #[cfg(target_os = "linux")]
    fn test_target() -> Target {
        crate::capture::x11_session::X11Target {
            display: ":99999".into(),
            xauthority: None,
        }
        .into()
    }

    #[cfg(not(target_os = "linux"))]
    fn test_target() -> Target {
        Target
    }
}
