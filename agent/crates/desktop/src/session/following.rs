//! A session that follows the screen at the machine ([`crate::follow`]):
//! it looks once a second, and when the screen is another one it releases
//! every held key, opens capture and input on the new screen, moves the
//! notice bar, and sends `displays`, `state` and a keyframe. While there is
//! nothing to show it stays open in [`DesktopState::Unavailable`], and a
//! capture failure means "look again" rather than the end of the session.
//! A control session also wakes a dark screen and keeps it awake
//! ([`super::wake`]).

use super::wake::Wake;
use super::{text, DesktopSession, Outgoing};
use crate::capture::DesktopState;
use crate::control::{AgentMessage, Mode};
use crate::follow::{NoScreen, ScreenWatch};
use crate::input::InputController;
use crate::notice;
use std::time::{Duration, Instant};

/// How often the session looks at the screen.
pub const LOOK_EVERY: Duration = Duration::from_secs(1);

pub(super) struct Follow {
    watch: Box<dyn ScreenWatch>,
    /// The key of the screen capture is open on; `None` while nothing is.
    open: Option<String>,
    /// Where the notice bar belongs while a screen is open.
    notice: Option<notice::Target>,
    /// What the browser was last told.
    state: DesktopState,
    next_look: Instant,
    /// When the open screen was opened. Capture failing on a screen that
    /// worked for a while means "look again now"; failing straight after
    /// opening waits for the next look, so a broken screen is reopened at
    /// most once a second.
    opened_at: Option<Instant>,
    /// Wakes the screen and keeps it awake: control sessions only.
    wake: Option<Wake>,
}

impl DesktopSession {
    /// A session that follows the screen `watch` looks at: it opens what is
    /// there now and reopens whenever it changes. It never fails to start;
    /// with nothing to show, it waits in [`DesktopState::Unavailable`].
    pub fn following(mode: Mode, mut watch: Box<dyn ScreenWatch>, now: Instant) -> Self {
        let wake = match mode {
            Mode::Control => match watch.waker() {
                Ok(waker) => Some(Wake::new(waker)),
                Err(reason) => {
                    log::warn!("This session cannot wake the screen: {reason}");
                    None
                }
            },
            Mode::Watch => None,
        };
        let mut session = DesktopSession::with(mode, Box::new(NoScreen::new()), None, now);
        session.follow = Some(Follow {
            watch,
            open: None,
            notice: None,
            state: DesktopState::Unavailable {
                reason: "Looking for the screen".to_string(),
            },
            next_look: now,
            opened_at: None,
            wake,
        });
        // Nothing goes out before `hello`, which sends displays and state.
        session.look(now, &mut Vec::new());
        session
    }

    /// The `state` message: what the screen shows.
    pub(super) fn state_message(&self) -> Outgoing {
        let screen = match &self.follow {
            Some(follow) => follow.state.clone(),
            None => self.capturer.state(),
        };
        text(AgentMessage::State { screen })
    }

    /// Looks at the screen when it is time. False while there is nothing to
    /// capture (always true for a session that does not follow).
    pub(super) fn follow_screen(&mut self, now: Instant, out: &mut Vec<Outgoing>) -> bool {
        let Some(follow) = &self.follow else {
            return true;
        };
        if now >= follow.next_look {
            self.look(now, out);
        }
        self.follow.as_ref().is_some_and(|f| f.open.is_some())
    }

    pub(super) fn request_screen_approval(&mut self, now: Instant, out: &mut Vec<Outgoing>) {
        let result = self
            .follow
            .as_mut()
            .ok_or_else(|| "This screen has no portal".to_string())
            .and_then(|follow| follow.watch.request_approval());
        if let Err(reason) = result {
            out.push(super::error(
                crate::control::ErrorCode::CaptureFailed,
                &reason,
            ));
        } else {
            self.look(now, out);
        }
    }

    /// The next look, while there is no screen to capture (frames wait).
    pub(super) fn waiting_for_screen(&self) -> Option<Instant> {
        self.follow
            .as_ref()
            .filter(|follow| follow.open.is_none())
            .map(|follow| follow.next_look)
    }

    /// Capture failed: the screen probably went away (sign-out, a user
    /// switch). Close it and look again instead of ending the session.
    pub(super) fn screen_lost(&mut self, now: Instant, message: &str) -> Vec<Outgoing> {
        log::warn!("Desktop capture failed; looking for the screen again: {message}");
        let mut out = Vec::new();
        if let Some(wake) = self.follow.as_mut().and_then(|f| f.wake.as_mut()) {
            wake.lost(now);
        }
        let settled = self.follow.as_ref().is_some_and(|follow| {
            follow
                .opened_at
                .is_some_and(|at| now.saturating_duration_since(at) >= LOOK_EVERY)
        });
        self.close_screen();
        if settled {
            self.look(now, &mut out);
        } else {
            self.set_state(
                DesktopState::Unavailable {
                    reason: format!("The screen went away: {message}"),
                },
                &mut out,
            );
        }
        out
    }

    fn look(&mut self, now: Instant, out: &mut Vec<Outgoing>) {
        let Some(follow) = self.follow.as_mut() else {
            return;
        };
        follow.next_look = now + LOOK_EVERY;
        let look = follow.watch.look();
        let mut seen = look.state;
        if let Some(wake) = follow.wake.as_mut() {
            if look.dark {
                seen = DesktopState::Unavailable {
                    reason: wake.dark(now).to_string(),
                };
            } else {
                wake.lit(now);
            }
        }
        if follow.open.as_deref() == Some(look.key.as_str()) {
            // Same screen: the bar comes back if its X server restarted.
            notice::keep_on(follow.notice.as_ref());
            self.set_state(seen, out);
            return;
        }
        if follow.open.is_some() {
            log::info!(
                "The screen at the machine changed ({}); reopening",
                look.key
            );
            self.close_screen();
        }
        let state = match seen {
            DesktopState::Unavailable { .. } | DesktopState::Approval { .. } => {
                notice::keep_on(None);
                seen
            }
            state => match self.open_screen(&look.key, now, out) {
                Ok(()) => state,
                Err(reason) => DesktopState::Unavailable { reason },
            },
        };
        self.set_state(state, out);
    }

    /// Opens capture (and input, for a control session) on the screen the
    /// last look saw, and moves the notice bar there.
    fn open_screen(
        &mut self,
        key: &str,
        now: Instant,
        out: &mut Vec<Outgoing>,
    ) -> Result<(), String> {
        let Some(follow) = self.follow.as_mut() else {
            return Err("this session does not follow the screen".to_string());
        };
        let platform = follow
            .watch
            .open()
            .map_err(|e| format!("Cannot open the screen: {e}"))?;
        let input = match self.mode {
            Mode::Control => Some(InputController::new(
                (platform.make_input)().map_err(|e| format!("Cannot control the screen: {e}"))?,
            )),
            Mode::Watch => None,
        };
        notice::keep_on(Some(&platform.notice_target));
        follow.notice = Some(platform.notice_target);
        follow.open = Some(key.to_string());
        follow.opened_at = Some(now);
        if let Some(wake) = follow.wake.as_mut() {
            wake.opened(now);
        }
        log::info!("Desktop session opened the screen {key}");
        self.capturer = platform.capturer;
        self.input = input;
        self.video.restart();
        self.cursor.restart();
        self.pacer.force_keyframe();
        out.push(self.displays_message());
        Ok(())
    }

    /// Lets go of the screen: keys up, no capture, no displays.
    fn close_screen(&mut self) {
        self.release_all();
        self.input = None;
        self.capturer = Box::new(NoScreen::new());
        if let Some(follow) = self.follow.as_mut() {
            follow.open = None;
            follow.notice = None;
            follow.opened_at = None;
            if let Some(wake) = follow.wake.as_mut() {
                wake.closed();
            }
        }
        self.video.restart();
        self.cursor.restart();
    }

    /// While a control session has the screen open: nudge when it is time.
    pub(super) fn keep_awake(&mut self, now: Instant) {
        if let Some(wake) = self.follow.as_mut().and_then(|f| f.wake.as_mut()) {
            wake.keep_awake(now);
        }
    }

    /// The viewer's input reached the screen.
    pub(super) fn viewer_input(&mut self, now: Instant) {
        if let Some(wake) = self.follow.as_mut().and_then(|f| f.wake.as_mut()) {
            wake.viewer_input(now);
        }
    }

    /// The session ended: let go of the wake device.
    pub(super) fn stop_waking(&mut self) {
        if let Some(follow) = self.follow.as_mut() {
            follow.wake = None;
        }
    }

    /// Tells the browser when the state changes. With nothing to show, the
    /// display list goes first, empty.
    fn set_state(&mut self, state: DesktopState, out: &mut Vec<Outgoing>) {
        let Some(follow) = self.follow.as_mut() else {
            return;
        };
        if follow.state != state {
            log::info!("The screen at the machine shows {state:?}");
            let nothing = matches!(
                state,
                DesktopState::Unavailable { .. } | DesktopState::Approval { .. }
            );
            follow.state = state;
            if nothing {
                out.push(self.displays_message());
            }
            out.push(self.state_message());
        }
    }
}

#[cfg(test)]
#[path = "following_tests.rs"]
mod tests;
