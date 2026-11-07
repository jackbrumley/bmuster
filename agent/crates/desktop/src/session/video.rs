//! One stream's video: captured frames, scaled when asked, diffed into
//! tiles and packed into tile batches (SPEC-DESKTOP 4.2). The session
//! decides when to capture; this decides what goes out.

use super::{text, Outgoing};
use crate::capture::{Capturer, Damage, Frame};
use crate::control::{AgentMessage, Codec};
use crate::encode::{scale, tiles::TileEncoder};
use crate::frame::{self, FrameInfo};

/// The stream parameters a `stream` message announces.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct StreamKey {
    pub display: usize,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
}

/// A frame that went out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct SentFrame {
    pub seq: u32,
    pub keyframe: bool,
}

pub(super) struct Video {
    encoder: TileEncoder,
    /// The downscaled frame, when the scale is below 1.
    scaled: Frame,
    stream: Option<StreamKey>,
    seq: u32,
}

impl Video {
    pub fn new() -> Self {
        Video {
            encoder: TileEncoder::new(),
            scaled: Frame::new(0, 0),
            stream: None,
            seq: 0,
        }
    }

    /// The stream as last announced, once a frame has gone out.
    pub fn stream(&self) -> Option<StreamKey> {
        self.stream
    }

    /// The seq of the last frame (0 before the first).
    pub fn seq(&self) -> u32 {
        self.seq
    }

    /// The next frame covers every tile.
    pub fn refresh(&mut self) {
        self.encoder.reset();
    }

    /// A new page (`hello`): every tile, and the `stream` message again.
    pub fn restart(&mut self) {
        self.encoder.reset();
        self.stream = None;
    }

    /// Captures and encodes one frame at `factor` and JPEG `quality`.
    /// Returns the frame sent, or `None` when nothing changed.
    pub fn produce(
        &mut self,
        capturer: &mut dyn Capturer,
        factor: f64,
        keyframe: bool,
        quality: u8,
        pts: u64,
        out: &mut Vec<Outgoing>,
    ) -> Result<Option<SentFrame>, String> {
        let damage = capturer.capture(keyframe).map_err(|e| e.0)?;
        let source = capturer.frame();
        let (width, height) = scale::scaled_size(source.width, source.height, factor);
        let scaled = (width, height) != (source.width, source.height);
        let damage = if scaled {
            if (self.scaled.width, self.scaled.height) != (width, height) {
                self.scaled = Frame::new(width, height);
            }
            if damage != Damage::None {
                scale::downscale(source, &mut self.scaled);
            }
            scale::scale_damage(&damage, (source.width, source.height), (width, height))
        } else {
            damage
        };
        let frame = if scaled { &self.scaled } else { source };

        let key = StreamKey {
            display: capturer.current(),
            width,
            height,
            scale: if scaled { factor } else { 1.0 },
        };
        let new_stream = self.stream != Some(key);
        let size_changed = self
            .stream
            .is_some_and(|old| (old.width, old.height) != (width, height));
        let encoded = self
            .encoder
            .encode(frame, &damage, keyframe || new_stream, quality)
            .map_err(|e| e.0)?;
        if encoded.tiles.is_empty() && !encoded.keyframe {
            return Ok(None);
        }
        if new_stream {
            let display = capturer
                .displays()
                .get(key.display)
                .map(|d| d.id.clone())
                .unwrap_or_default();
            out.push(text(AgentMessage::Stream {
                display,
                codec: Codec::Jpeg,
                width,
                height,
                scale: key.scale,
            }));
            self.stream = Some(key);
        }

        self.seq = match self.seq.wrapping_add(1) {
            0 => 1,
            seq => seq,
        };
        let info = FrameInfo {
            display: key.display as u8,
            seq: self.seq,
            pts,
            width: width as u16,
            height: height as u16,
            keyframe: encoded.keyframe,
            size_changed,
        };
        for batch in frame::tile_batches(info, &encoded.tiles, frame::MAX_BATCH_BYTES) {
            out.push(Outgoing::Binary(batch));
        }
        Ok(Some(SentFrame {
            seq: self.seq,
            keyframe: encoded.keyframe,
        }))
    }
}
