//! The X11 clipboard (SPEC-DESKTOP 21.4): the `CLIPBOARD` selection on one
//! display, through the session's Xauthority like capture and XTest.
//!
//! `arboard` is not used: it opens `DISPLAY` from the process environment,
//! and the root agent serves whichever display seat0 shows.
//!
//! - **Setting** makes a hidden window the selection's owner, and a thread
//!   answers other clients' `SelectionRequest`s from it until the
//!   [`X11Clipboard`] is dropped (the control session leaves the screen) or
//!   another client takes the selection.
//! - **Reading** asks the owner to convert the selection onto a property of
//!   a window on a short-lived connection of its own, so its events never
//!   mix with the owner thread's, and follows the `INCR` protocol when the
//!   owner sends the text in parts.

use super::{too_large, CLIPBOARD_WAIT};
use crate::capture::x11_session::{connect, X11Target};
use crate::control::MAX_CLIPBOARD_BYTES;
use crate::input::{InputError, InputResult};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use x11rb::connection::{Connection, RequestConnection};
use x11rb::protocol::xproto::{
    Atom, AtomEnum, ClientMessageEvent, ConnectionExt as _, CreateWindowAux, EventMask, PropMode,
    Property, SelectionNotifyEvent, SelectionRequestEvent, Window, WindowClass,
    SELECTION_NOTIFY_EVENT,
};
use x11rb::protocol::Event;
use x11rb::rust_connection::RustConnection;
use x11rb::wrapper::ConnectionExt as _;
use x11rb::{COPY_FROM_PARENT, CURRENT_TIME, NONE};

/// How often a read looks for the owner's answer.
const POLL: Duration = Duration::from_millis(5);
/// Room for a `ChangeProperty` request's own fields.
const REQUEST_OVERHEAD: usize = 64;

fn failed<E: std::fmt::Display>(what: &'static str) -> impl FnOnce(E) -> InputError {
    move |error| InputError(format!("X clipboard, {what}: {error}"))
}

#[derive(Debug, Clone, Copy)]
struct Atoms {
    clipboard: Atom,
    targets: Atom,
    utf8_string: Atom,
    text: Atom,
    text_plain_utf8: Atom,
    incr: Atom,
    /// The property a read asks the owner to fill.
    property: Atom,
    /// Tells the owner thread to stop.
    stop: Atom,
}

impl Atoms {
    fn intern(connection: &RustConnection) -> InputResult<Atoms> {
        let names: [&[u8]; 8] = [
            b"CLIPBOARD",
            b"TARGETS",
            b"UTF8_STRING",
            b"TEXT",
            b"text/plain;charset=utf-8",
            b"INCR",
            b"BMUSTER_CLIPBOARD",
            b"BMUSTER_CLIPBOARD_STOP",
        ];
        let cookies = names
            .iter()
            .map(|name| connection.intern_atom(false, name))
            .collect::<Result<Vec<_>, _>>()
            .map_err(failed("interning atoms"))?;
        let mut atoms = Vec::with_capacity(cookies.len());
        for cookie in cookies {
            atoms.push(cookie.reply().map_err(failed("interning atoms"))?.atom);
        }
        Ok(Atoms {
            clipboard: atoms[0],
            targets: atoms[1],
            utf8_string: atoms[2],
            text: atoms[3],
            text_plain_utf8: atoms[4],
            incr: atoms[5],
            property: atoms[6],
            stop: atoms[7],
        })
    }
}

/// A connection with one hidden window on the display's first screen.
fn open_window(target: &X11Target) -> InputResult<(RustConnection, Window, Atoms)> {
    let (connection, screen) = connect(target).map_err(InputError)?;
    let root = connection
        .setup()
        .roots
        .get(screen)
        .ok_or_else(|| InputError("the X server has no such screen".into()))?
        .root;
    let atoms = Atoms::intern(&connection)?;
    let window = connection
        .generate_id()
        .map_err(failed("making a window id"))?;
    connection
        .create_window(
            COPY_FROM_PARENT as u8,
            window,
            root,
            0,
            0,
            1,
            1,
            0,
            WindowClass::INPUT_ONLY,
            COPY_FROM_PARENT,
            &CreateWindowAux::new().event_mask(EventMask::PROPERTY_CHANGE),
        )
        .map_err(failed("making a window"))?
        .check()
        .map_err(failed("making a window"))?;
    Ok((connection, window, atoms))
}

/// The `CLIPBOARD` selection of one X display.
pub struct X11Clipboard {
    target: X11Target,
    /// Made on the first push; answers other clients while it lives.
    owner: Option<Owner>,
    /// Made on the first [`X11Clipboard::changed`] (clipboard sharing).
    watch: Option<super::x11_watch::SelectionWatch>,
}

impl X11Clipboard {
    pub fn new(target: X11Target) -> Self {
        X11Clipboard {
            target,
            owner: None,
            watch: None,
        }
    }

    /// Whether the selection changed hands since the last call; the first
    /// call starts watching and says no (SPEC-DESKTOP 21.11).
    pub fn changed(&mut self) -> InputResult<bool> {
        match self.watch.as_mut() {
            Some(watch) => watch.changed(),
            None => {
                self.watch = Some(super::x11_watch::SelectionWatch::start(&self.target)?);
                Ok(false)
            }
        }
    }

    /// Makes `text` the selection's contents.
    pub fn set(&mut self, text: &str) -> InputResult<()> {
        if self.owner.is_none() {
            self.owner = Some(Owner::start(&self.target)?);
        }
        let Some(owner) = self.owner.as_ref() else {
            return Err(InputError("X clipboard owner did not start".into()));
        };
        owner.own(text.as_bytes().to_vec())
    }

    /// The selection's text; empty when nobody owns it or it holds no text.
    pub fn get(&mut self) -> InputResult<String> {
        read(&self.target)
    }
}

/// The hidden window that owns the selection, and its answering thread.
struct Owner {
    connection: Arc<RustConnection>,
    window: Window,
    atoms: Atoms,
    text: Arc<Mutex<Vec<u8>>>,
    thread: Option<JoinHandle<()>>,
}

impl Owner {
    fn start(target: &X11Target) -> InputResult<Owner> {
        let (connection, window, atoms) = open_window(target)?;
        let connection = Arc::new(connection);
        let text = Arc::new(Mutex::new(Vec::new()));
        let thread = {
            let (connection, text) = (Arc::clone(&connection), Arc::clone(&text));
            std::thread::Builder::new()
                .name("x11-clipboard".into())
                .spawn(move || serve(&connection, window, atoms, &text))
                .map_err(failed("starting its thread"))?
        };
        Ok(Owner {
            connection,
            window,
            atoms,
            text,
            thread: Some(thread),
        })
    }

    fn own(&self, text: Vec<u8>) -> InputResult<()> {
        if text.len() + REQUEST_OVERHEAD > self.connection.maximum_request_bytes() {
            return Err(InputError(
                "The text is longer than this X server accepts in one piece".into(),
            ));
        }
        *self.text.lock().unwrap_or_else(PoisonError::into_inner) = text;
        let connection = &self.connection;
        connection
            .set_selection_owner(self.window, self.atoms.clipboard, CURRENT_TIME)
            .map_err(failed("taking the selection"))?;
        let owner = connection
            .get_selection_owner(self.atoms.clipboard)
            .map_err(failed("checking the selection"))?
            .reply()
            .map_err(failed("checking the selection"))?
            .owner;
        if owner != self.window {
            return Err(InputError(
                "Another program on the machine kept the clipboard".into(),
            ));
        }
        Ok(())
    }
}

impl Drop for Owner {
    fn drop(&mut self) {
        let stop = ClientMessageEvent::new(32, self.window, self.atoms.stop, [0u32; 5]);
        let sent = self
            .connection
            .send_event(false, self.window, EventMask::NO_EVENT, stop)
            .map(|_| ())
            .and_then(|()| self.connection.flush());
        if sent.is_ok() {
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
        // The selection goes with the window.
        let _ = self.connection.destroy_window(self.window);
        let _ = self.connection.flush();
    }
}

/// The owner thread: answers requests for the selection until told to stop
/// or the connection fails.
fn serve(connection: &RustConnection, window: Window, atoms: Atoms, text: &Mutex<Vec<u8>>) {
    loop {
        let event = match connection.wait_for_event() {
            Ok(event) => event,
            Err(error) => {
                log::warn!("X clipboard connection failed: {error}");
                return;
            }
        };
        match event {
            Event::ClientMessage(message)
                if message.window == window && message.type_ == atoms.stop =>
            {
                return;
            }
            Event::SelectionRequest(request) => {
                let held = text.lock().unwrap_or_else(PoisonError::into_inner).clone();
                if let Err(error) = answer(connection, atoms, &held, &request) {
                    log::warn!("Could not answer an X clipboard request: {error}");
                }
            }
            Event::SelectionClear(clear) if clear.owner == window => {
                // Another program copied something: forget ours.
                text.lock().unwrap_or_else(PoisonError::into_inner).clear();
            }
            _ => {}
        }
    }
}

/// Fills the requestor's property with the text in the asked-for form (or
/// the list of forms), then tells it so; `NONE` for a form not offered.
fn answer(
    connection: &RustConnection,
    atoms: Atoms,
    text: &[u8],
    request: &SelectionRequestEvent,
) -> Result<(), Box<dyn std::error::Error>> {
    // Obsolete clients leave the property out; ICCCM says use the target.
    let property = if request.property == NONE {
        request.target
    } else {
        request.property
    };
    let string = Atom::from(AtomEnum::STRING);
    let fits = text.len() + REQUEST_OVERHEAD <= connection.maximum_request_bytes();
    let target = request.target;
    let answered = if request.selection != atoms.clipboard {
        false
    } else if target == atoms.targets {
        let forms = [
            atoms.targets,
            atoms.utf8_string,
            string,
            atoms.text,
            atoms.text_plain_utf8,
        ];
        connection.change_property32(
            PropMode::REPLACE,
            request.requestor,
            property,
            AtomEnum::ATOM,
            &forms,
        )?;
        true
    } else if fits && [atoms.utf8_string, atoms.text, atoms.text_plain_utf8].contains(&target) {
        let kind = if target == atoms.text {
            atoms.utf8_string
        } else {
            target
        };
        connection.change_property8(PropMode::REPLACE, request.requestor, property, kind, text)?;
        true
    } else if fits && target == string {
        let latin1 = latin1(text);
        connection.change_property8(
            PropMode::REPLACE,
            request.requestor,
            property,
            string,
            &latin1,
        )?;
        true
    } else {
        false
    };
    let notify = SelectionNotifyEvent {
        response_type: SELECTION_NOTIFY_EVENT,
        sequence: 0,
        time: request.time,
        requestor: request.requestor,
        selection: request.selection,
        target,
        property: if answered { property } else { NONE },
    };
    connection.send_event(false, request.requestor, EventMask::NO_EVENT, notify)?;
    connection.flush()?;
    Ok(())
}

/// UTF-8 as ISO Latin-1 (the `STRING` form): characters past U+00FF become `?`.
fn latin1(text: &[u8]) -> Vec<u8> {
    String::from_utf8_lossy(text)
        .chars()
        .map(|c| u8::try_from(u32::from(c)).unwrap_or(b'?'))
        .collect()
}

/// Reads the selection as `UTF8_STRING`, or as `STRING` from an owner that
/// offers only that.
fn read(target: &X11Target) -> InputResult<String> {
    let (connection, window, atoms) = open_window(target)?;
    let owner = connection
        .get_selection_owner(atoms.clipboard)
        .map_err(failed("finding the owner"))?
        .reply()
        .map_err(failed("finding the owner"))?
        .owner;
    if owner == NONE {
        return Ok(String::new());
    }
    let string = Atom::from(AtomEnum::STRING);
    for form in [atoms.utf8_string, string] {
        if let Some(bytes) = convert(&connection, window, atoms, form)? {
            return Ok(if form == string {
                bytes.iter().map(|&b| char::from(b)).collect()
            } else {
                String::from_utf8_lossy(&bytes).into_owned()
            });
        }
    }
    // An owner with no text (an image, files) reads as empty.
    Ok(String::new())
}

/// Asks the owner for the selection as `form`; `None` when it refuses.
fn convert(
    connection: &RustConnection,
    window: Window,
    atoms: Atoms,
    form: Atom,
) -> InputResult<Option<Vec<u8>>> {
    connection
        .convert_selection(window, atoms.clipboard, form, atoms.property, CURRENT_TIME)
        .map_err(failed("asking for the text"))?;
    connection.flush().map_err(failed("asking for the text"))?;
    let deadline = Instant::now() + CLIPBOARD_WAIT;
    let notify = wait_for(connection, deadline, |event| match event {
        Event::SelectionNotify(notify) if notify.requestor == window => Some(notify.property),
        _ => None,
    })?;
    if notify == NONE {
        return Ok(None);
    }
    let first = take_property(connection, window, atoms.property)?;
    if first.0 != atoms.incr {
        return Ok(Some(first.1));
    }
    // INCR: deleting the property (done by the read above) asks for each
    // next part; an empty part ends it.
    let mut text = Vec::new();
    loop {
        let deadline = Instant::now() + CLIPBOARD_WAIT;
        wait_for(connection, deadline, |event| match event {
            Event::PropertyNotify(change)
                if change.window == window
                    && change.atom == atoms.property
                    && change.state == Property::NEW_VALUE =>
            {
                Some(())
            }
            _ => None,
        })?;
        let (_, part) = take_property(connection, window, atoms.property)?;
        if part.is_empty() {
            return Ok(Some(text));
        }
        text.extend_from_slice(&part);
        if text.len() > MAX_CLIPBOARD_BYTES {
            return Err(too_large());
        }
    }
}

/// Reads and deletes the property: its type and up to one byte more than
/// [`MAX_CLIPBOARD_BYTES`] of it.
fn take_property(
    connection: &RustConnection,
    window: Window,
    property: Atom,
) -> InputResult<(Atom, Vec<u8>)> {
    // In 32-bit units; one more than the limit, so too much shows.
    let words = u32::try_from(MAX_CLIPBOARD_BYTES / 4 + 1).unwrap_or(u32::MAX);
    let reply = connection
        .get_property(true, window, property, AtomEnum::ANY, 0, words)
        .map_err(failed("reading the text"))?
        .reply()
        .map_err(failed("reading the text"))?;
    if reply.bytes_after > 0 || reply.value.len() > MAX_CLIPBOARD_BYTES {
        return Err(too_large());
    }
    Ok((reply.type_, reply.value))
}

/// Waits until `pick` takes an event, or fails at `deadline`.
fn wait_for<T>(
    connection: &RustConnection,
    deadline: Instant,
    mut pick: impl FnMut(&Event) -> Option<T>,
) -> InputResult<T> {
    loop {
        while let Some(event) = connection
            .poll_for_event()
            .map_err(failed("waiting for the owner"))?
        {
            if let Some(value) = pick(&event) {
                return Ok(value);
            }
        }
        if Instant::now() >= deadline {
            return Err(InputError(
                "The program that holds the machine's clipboard did not answer".into(),
            ));
        }
        std::thread::sleep(POLL);
    }
}

#[cfg(test)]
mod tests {
    use super::latin1;

    #[test]
    fn x11_clipboard_string_form_is_latin1_with_question_marks_past_it() {
        assert_eq!(latin1("café €".as_bytes()), b"caf\xe9 ?".to_vec());
    }
}
