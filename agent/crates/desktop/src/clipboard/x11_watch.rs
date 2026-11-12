//! Noticing that the X11 `CLIPBOARD` selection changed hands (SPEC-DESKTOP
//! 21.11, clipboard sharing): XFixes `SelectSelectionInput` on a
//! connection of its own, so its events never mix with the owner thread's
//! or a read's. Only the fact of a change is noticed here; the session
//! reads the text afterwards through [`super::x11::X11Clipboard`].

use crate::capture::x11_session::{connect, X11Target};
use crate::input::{InputError, InputResult};
use x11rb::connection::Connection as _;
use x11rb::protocol::xfixes::{ConnectionExt as _, SelectionEventMask};
use x11rb::protocol::xproto::ConnectionExt as _;
use x11rb::protocol::Event;
use x11rb::rust_connection::RustConnection;

fn failed<E: std::fmt::Display>(what: &'static str) -> impl FnOnce(E) -> InputError {
    move |error| InputError(format!("X clipboard watch, {what}: {error}"))
}

/// Watches one display's `CLIPBOARD` selection.
pub struct SelectionWatch {
    connection: RustConnection,
}

impl SelectionWatch {
    pub fn start(target: &X11Target) -> InputResult<SelectionWatch> {
        let (connection, screen) = connect(target).map_err(InputError)?;
        let root = connection
            .setup()
            .roots
            .get(screen)
            .ok_or_else(|| InputError("the X server has no such screen".into()))?
            .root;
        connection
            .xfixes_query_version(5, 0)
            .map_err(failed("asking for XFixes"))?
            .reply()
            .map_err(failed("asking for XFixes"))?;
        let clipboard = connection
            .intern_atom(false, b"CLIPBOARD")
            .map_err(failed("interning CLIPBOARD"))?
            .reply()
            .map_err(failed("interning CLIPBOARD"))?
            .atom;
        connection
            .xfixes_select_selection_input(
                root,
                clipboard,
                SelectionEventMask::SET_SELECTION_OWNER
                    | SelectionEventMask::SELECTION_WINDOW_DESTROY
                    | SelectionEventMask::SELECTION_CLIENT_CLOSE,
            )
            .map_err(failed("watching CLIPBOARD"))?
            .check()
            .map_err(failed("watching CLIPBOARD"))?;
        Ok(SelectionWatch { connection })
    }

    /// Whether the selection changed hands since the last call (or since
    /// the watch started). Never blocks.
    pub fn changed(&mut self) -> InputResult<bool> {
        let mut changed = false;
        while let Some(event) = self
            .connection
            .poll_for_event()
            .map_err(failed("reading events"))?
        {
            changed |= matches!(event, Event::XfixesSelectionNotify(_));
        }
        Ok(changed)
    }
}
