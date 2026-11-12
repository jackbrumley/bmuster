//! Route 1: Wayland data-control (`ext-data-control-v1`, then
//! `zwlr_data_control_manager_v1`) through `wl-clipboard-rs`, which needs
//! no window and no focus. KWin, wlroots compositors (Sway, Hyprland,
//! river, labwc, Wayfire), COSMIC and niri offer it; GNOME's mutter does
//! not.
//!
//! A push makes a data source offering the text as
//! `text/plain;charset=utf-8`, `text/plain`, `UTF8_STRING`, `TEXT` and
//! `STRING`, served by a thread of `wl-clipboard-rs` until another program
//! takes the selection (the compositor cancels the source) or the helper
//! ends with the control session.

use super::routes::{decode, read_within, text_type, Backend, Failure};
use bmuster_desktop::clipboard::CLIPBOARD_WAIT;
use bmuster_desktop::control::MAX_CLIPBOARD_BYTES;
use wl_clipboard_rs::{copy, paste};

pub(crate) struct DataControl;

/// No compositor to talk to, or one without data-control.
fn copy_failure(error: copy::Error) -> Failure {
    match error {
        copy::Error::MissingProtocol { .. }
        | copy::Error::WaylandConnection(_)
        | copy::Error::SocketOpenError(_)
        | copy::Error::NoSeats => Failure::Unsupported(error.to_string()),
        other => Failure::Failed(format!("Wayland clipboard: {other}")),
    }
}

fn paste_failure(error: paste::Error) -> Result<String, Failure> {
    match error {
        // Nothing on the clipboard, or nothing that is text.
        paste::Error::ClipboardEmpty | paste::Error::NoMimeType => Ok(String::new()),
        paste::Error::MissingProtocol { .. }
        | paste::Error::WaylandConnection(_)
        | paste::Error::SocketOpenError(_)
        | paste::Error::NoSeats => Err(Failure::Unsupported(error.to_string())),
        other => Err(Failure::Failed(format!("Wayland clipboard: {other}"))),
    }
}

impl Backend for DataControl {
    fn name(&self) -> &'static str {
        "Wayland data-control"
    }

    fn set(&mut self, text: &str) -> Result<(), Failure> {
        copy::Options::new()
            .copy(
                copy::Source::Bytes(text.as_bytes().into()),
                copy::MimeType::Text,
            )
            .map_err(copy_failure)
    }

    fn get(&mut self) -> Result<String, Failure> {
        use paste::{ClipboardType, MimeType, Seat};
        let offered = match paste::get_mime_types_ordered(ClipboardType::Regular, Seat::Unspecified)
        {
            Ok(offered) => offered,
            Err(error) => return paste_failure(error),
        };
        let Some(mime_type) = text_type(&offered) else {
            return Ok(String::new());
        };
        let (pipe, mime_type) = match paste::get_contents(
            ClipboardType::Regular,
            Seat::Unspecified,
            MimeType::Specific(mime_type),
        ) {
            Ok(contents) => contents,
            Err(error) => return paste_failure(error),
        };
        let bytes = read_within(pipe.into(), MAX_CLIPBOARD_BYTES, CLIPBOARD_WAIT)
            .map_err(Failure::Failed)?;
        Ok(decode(&mime_type, &bytes))
    }
}
