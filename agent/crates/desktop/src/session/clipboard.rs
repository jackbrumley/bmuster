//! Copy and paste in a session (SPEC-DESKTOP 21): the viewer's button
//! presses (`clipboard-push`, `clipboard-pull`) and clipboard sharing
//! (21.11), where the session watches the screen's clipboard and sends new
//! text by itself (`clipboard-changed`), and takes the viewer's device
//! clipboard (`clipboard-sync`) without a reply the viewer has to read.
//!
//! Only a control session has an injector, and so a clipboard. Nothing
//! here logs the text; sharing remembers only hashes of it, to tell the
//! machine's own copy of a pushed text from a new one.

use super::{error, text, DesktopSession, Outgoing};
use crate::control::{self, AgentMessage, ErrorCode};
use std::collections::hash_map::DefaultHasher;
use std::collections::HashSet;
use std::hash::{Hash as _, Hasher as _};
use std::time::{Duration, Instant};

/// How often a sharing session asks whether the clipboard changed.
pub const SHARE_EVERY: Duration = Duration::from_millis(500);

/// A short fingerprint of a clipboard text, so the session can recognise a
/// text without keeping it.
fn fingerprint(text: &str) -> u64 {
    let mut hasher = DefaultHasher::new();
    text.hash(&mut hasher);
    hasher.finish()
}

/// Clipboard sharing's state for one session.
#[derive(Debug, Default)]
pub struct Sharing {
    on: bool,
    /// The last text the viewer put on the machine (pushed or synced):
    /// the machine's clipboard holding it is no news.
    pushed: Option<u64>,
    /// The last text sent to the viewer.
    sent: Option<u64>,
    /// When to next ask the injector.
    next: Option<Instant>,
    /// Reasons already logged: a clipboard that cannot be read fails the
    /// same way twice a second.
    warned: HashSet<String>,
}

impl Sharing {
    /// `clipboard-share`: on watches from the next tick, off stops.
    pub fn turn(&mut self, on: bool, now: Instant) {
        if on != self.on {
            log::info!(
                "Desktop clipboard sharing {}",
                if on { "on" } else { "off" }
            );
        }
        self.on = on;
        self.next = Some(now);
    }

    fn warn_once(&mut self, what: &str, reason: &str) {
        if self.warned.insert(format!("{what}: {reason}")) {
            log::warn!("Desktop clipboard sharing {what}: {reason}");
        }
    }

    /// Whether `text` is news for the viewer: not empty, not what they put
    /// there, not what they were last sent.
    fn is_news(&self, text: &str) -> bool {
        let print = Some(fingerprint(text));
        !text.is_empty() && print != self.pushed && print != self.sent
    }
}

fn clipboard_failed(reason: &str, out: &mut Vec<Outgoing>) {
    log::warn!("Desktop clipboard: {reason}");
    out.push(error(ErrorCode::ClipboardFailed, reason));
}

impl DesktopSession {
    /// Puts the viewer's text on the screen's clipboard (SPEC-DESKTOP 21).
    /// A following session has no injector while the screen shows nothing
    /// it can open.
    pub(super) fn clipboard_push(&mut self, text: &str, out: &mut Vec<Outgoing>) {
        let Some(input) = self.input.as_mut() else {
            clipboard_failed(&crate::clipboard::not_available().0, out);
            return;
        };
        match input.set_clipboard(text) {
            Ok(()) => {
                self.sharing.pushed = Some(fingerprint(text));
                out.push(self::text(AgentMessage::ClipboardSent {
                    bytes: text.len(),
                }));
            }
            Err(err) => clipboard_failed(&err.0, out),
        }
    }

    /// Sends the screen's clipboard text to the viewer.
    pub(super) fn clipboard_pull(&mut self, out: &mut Vec<Outgoing>) {
        let Some(input) = self.input.as_mut() else {
            clipboard_failed(&crate::clipboard::not_available().0, out);
            return;
        };
        match input.clipboard() {
            Ok(text) if text.len() > control::MAX_CLIPBOARD_BYTES => {
                clipboard_failed(&crate::clipboard::too_large().0, out);
            }
            Ok(text) => {
                self.sharing.sent = Some(fingerprint(&text));
                out.push(self::text(AgentMessage::Clipboard { text }));
            }
            Err(err) => clipboard_failed(&err.0, out),
        }
    }

    /// The viewer's device clipboard, sent while sharing is on: put on the
    /// machine like a push, answered `clipboard-synced`, and a failure is
    /// `clipboard-sync-failed` (logged once per reason, for the viewer's
    /// page to keep quiet about).
    pub(super) fn clipboard_sync(&mut self, text: &str, out: &mut Vec<Outgoing>) {
        if !self.sharing.on {
            return;
        }
        let Some(input) = self.input.as_mut() else {
            return;
        };
        match input.set_clipboard(text) {
            Ok(()) => {
                let print = Some(fingerprint(text));
                self.sharing.pushed = print;
                self.sharing.sent = print;
                out.push(self::text(AgentMessage::ClipboardSynced {
                    bytes: text.len(),
                }));
            }
            Err(err) => {
                self.sharing
                    .warn_once("could not set the clipboard", &err.0);
                out.push(error(ErrorCode::ClipboardSyncFailed, &err.0));
            }
        }
    }

    /// Clipboard sharing, on each tick: every [`SHARE_EVERY`] asks the
    /// injector whether the clipboard changed and, when it did, sends the
    /// new text unless it is the viewer's own.
    pub(super) fn watch_clipboard(&mut self, now: Instant, out: &mut Vec<Outgoing>) {
        if !self.sharing.on || self.sharing.next.is_some_and(|next| now < next) {
            return;
        }
        self.sharing.next = Some(now + SHARE_EVERY);
        let Some(input) = self.input.as_mut() else {
            return;
        };
        let read = match input.clipboard_changed() {
            Ok(true) => input.clipboard(),
            Ok(false) => return,
            Err(err) => {
                self.sharing.warn_once("cannot watch the clipboard", &err.0);
                return;
            }
        };
        match read {
            Ok(text) if text.len() > control::MAX_CLIPBOARD_BYTES => {
                self.sharing
                    .warn_once("did not share the clipboard", "it holds over 1 MB");
            }
            Ok(text) if self.sharing.is_news(&text) => {
                self.sharing.sent = Some(fingerprint(&text));
                out.push(self::text(AgentMessage::ClipboardChanged { text }));
            }
            Ok(_) => {}
            Err(err) => {
                self.sharing.warn_once("cannot read the clipboard", &err.0);
            }
        }
    }
}
