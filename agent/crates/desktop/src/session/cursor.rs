//! The remote cursor (SPEC-DESKTOP 4.2): each new shape once as a PNG, then
//! the position whenever it changes, in encoded-frame pixels. The browser
//! draws it over the canvas, so pointer movement costs no video.

use super::video::StreamKey;
use super::Outgoing;
use crate::capture::{Capturer, Rect};
use crate::encode::png;
use crate::frame::{self, CursorContext};
use std::collections::HashSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CursorSent {
    id: u32,
    x: i32,
    y: i32,
    visible: bool,
}

#[derive(Default)]
pub(super) struct CursorTracker {
    shapes_sent: HashSet<u32>,
    sent: Option<CursorSent>,
    /// A failed read is logged once, not every tick.
    failed: bool,
}

impl CursorTracker {
    /// A new page (`hello`) has no shapes: send them again.
    pub fn restart(&mut self) {
        self.shapes_sent.clear();
        self.sent = None;
    }

    /// Another display: send the position again.
    pub fn forget_position(&mut self) {
        self.sent = None;
    }

    /// Reads the cursor and adds shape and position messages for `stream`,
    /// whose display covers `rect` on the desktop.
    pub fn update(
        &mut self,
        capturer: &mut dyn Capturer,
        stream: StreamKey,
        rect: Rect,
        seq: u32,
        pts: u64,
        out: &mut Vec<Outgoing>,
    ) {
        let state = match capturer.cursor() {
            Ok(state) => state,
            Err(err) => {
                if !self.failed {
                    self.failed = true;
                    log::warn!("Reading the cursor failed: {}", err.0);
                }
                return;
            }
        };
        let inside = state.x >= rect.x
            && state.y >= rect.y
            && i64::from(state.x) < i64::from(rect.x) + i64::from(rect.width)
            && i64::from(state.y) < i64::from(rect.y) + i64::from(rect.height);
        let sent = CursorSent {
            id: state.id,
            x: (f64::from(state.x - rect.x) * stream.scale).round() as i32,
            y: (f64::from(state.y - rect.y) * stream.scale).round() as i32,
            visible: state.visible && inside,
        };
        let context = CursorContext {
            display: stream.display as u8,
            seq,
            pts,
            width: stream.width as u16,
            height: stream.height as u16,
        };
        if sent.visible && !self.shapes_sent.contains(&sent.id) {
            match capturer.cursor_image(sent.id) {
                Ok(Some(image)) => {
                    let png = png::encode_rgba(image.width, image.height, &image.rgba);
                    let hotspot = (image.hotspot_x as u16, image.hotspot_y as u16);
                    out.push(Outgoing::Binary(frame::cursor_shape(
                        context, sent.id, hotspot, &png,
                    )));
                    self.shapes_sent.insert(sent.id);
                }
                // The shape changed again before it was read: next tick.
                Ok(None) => return,
                Err(err) => {
                    log::warn!("Reading the cursor shape failed: {}", err.0);
                    return;
                }
            }
        }
        if self.sent != Some(sent) {
            out.push(Outgoing::Binary(frame::cursor_position(
                context,
                sent.id,
                sent.x,
                sent.y,
                sent.visible,
            )));
            self.sent = Some(sent);
        }
    }
}
