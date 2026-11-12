//! The clipboard helper's watch for clipboard sharing (SPEC-DESKTOP
//! 21.11): tells the agent each time another program takes the session's
//! clipboard, through the same routes as the calls and in the same order.
//! Data-control reports selection changes as they happen; on XWayland the
//! XFixes watch is asked four times a second. Only the fact of a change
//! crosses the socket; the agent reads the text with a call.

use bmuster_desktop::capture::x11_session::X11Target;
use bmuster_desktop::clipboard::x11_watch::SelectionWatch;
use std::time::Duration;
use wl_clipboard_rs::paste::Seat;
use wl_clipboard_rs::watch::{ClipboardType, Watcher};

/// How often the XWayland watch is asked.
const X11_EVERY: Duration = Duration::from_millis(250);

/// Calls `tell` for each change until it returns false (the agent has
/// gone) or no route can be watched.
pub(crate) fn watch(x11: Result<X11Target, String>, tell: impl Fn() -> bool) {
    match Watcher::new(ClipboardType::Regular, Seat::Unspecified) {
        Ok(mut watcher) => {
            // The first event is the clipboard as it stood: not news.
            let mut first = true;
            loop {
                match watcher.next_event() {
                    Ok(Some(_)) if first => first = false,
                    Ok(Some(_)) => {
                        if !tell() {
                            return;
                        }
                    }
                    Ok(None) => return,
                    Err(error) => {
                        log::warn!("The Wayland clipboard watch stopped: {error}");
                        return;
                    }
                }
            }
        }
        Err(error) => log::info!("No Wayland data-control clipboard watch: {error}"),
    }
    let target = match x11 {
        Ok(target) => target,
        Err(reason) => {
            log::info!("No X11 clipboard watch: {reason}");
            return;
        }
    };
    let mut selection = match SelectionWatch::start(&target) {
        Ok(selection) => selection,
        Err(error) => {
            log::info!("No X11 clipboard watch: {}", error.0);
            return;
        }
    };
    loop {
        std::thread::sleep(X11_EVERY);
        match selection.changed() {
            Ok(true) => {
                if !tell() {
                    return;
                }
            }
            Ok(false) => {}
            Err(error) => {
                log::warn!("The X11 clipboard watch stopped: {}", error.0);
                return;
            }
        }
    }
}
