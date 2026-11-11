//! One stream's video: captured frames, scaled when asked, diffed into
//! tiles and packed into tile batches (SPEC-DESKTOP 4.2). The session
//! decides when to capture; this decides what goes out.

use super::{text, Outgoing};
use crate::capture::{view_id, Capturer, Damage, Frame, View};
use crate::control::{AgentMessage, Codec};
use crate::encode::{scale, tiles::TileEncoder};
use crate::frame::{self, FrameInfo};
use std::time::{Duration, Instant};

/// The stream parameters a `stream` message announces.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct StreamKey {
    pub view: View,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
}

impl StreamKey {
    /// The frame header's display byte: the index, or 255 for all screens.
    pub fn wire_display(&self) -> u8 {
        match self.view {
            View::Display(index) => u8::try_from(index).unwrap_or(u8::MAX - 1),
            View::All => u8::MAX,
        }
    }
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
    figures: Figures,
}

/// What the video did since the figures were last taken (SPEC-DIAGNOSTICS 3).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Figures {
    pub frames_sent: u64,
    /// Captures made, and the time they took.
    pub captures: u64,
    pub capture_time: Duration,
    /// Encodes made (scaling included), and the time they took.
    pub encodes: u64,
    pub encode_time: Duration,
    pub bytes_sent: u64,
    pub tiles_sent: u64,
    /// Capture ticks skipped because the viewer was behind.
    pub dropped_frames: u64,
}

impl Video {
    pub fn new() -> Self {
        Video {
            encoder: TileEncoder::new(),
            scaled: Frame::new(0, 0),
            stream: None,
            seq: 0,
            figures: Figures::default(),
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

    /// The figures since the last call, which starts them again.
    pub fn take_figures(&mut self) -> Figures {
        std::mem::take(&mut self.figures)
    }

    /// A capture tick skipped because the viewer was behind.
    pub fn dropped(&mut self) {
        self.figures.dropped_frames += 1;
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

    /// Captures and encodes one frame at the factor `factor` gives for the
    /// captured size, and JPEG `quality`. Returns the frame sent, or `None`
    /// when nothing changed.
    pub fn produce(
        &mut self,
        capturer: &mut dyn Capturer,
        factor: &dyn Fn(u32, u32) -> f64,
        keyframe: bool,
        quality: u8,
        pts: u64,
        out: &mut Vec<Outgoing>,
    ) -> Result<Option<SentFrame>, String> {
        let captured = Instant::now();
        let damage = capturer.capture(keyframe).map_err(|e| e.0)?;
        self.figures.captures += 1;
        self.figures.capture_time += captured.elapsed();
        let encoding = Instant::now();
        let source = capturer.frame();
        let factor = factor(source.width, source.height);
        let (width, height) = scale::scaled_size(source.width, source.height, factor);
        let scaled = (width, height) != (source.width, source.height);
        let key = StreamKey {
            view: capturer.view(),
            width,
            height,
            scale: if scaled { factor } else { 1.0 },
        };
        let new_stream = self.stream != Some(key);
        let damage = if scaled {
            if (self.scaled.width, self.scaled.height) != (width, height) {
                self.scaled = Frame::new(width, height);
            }
            // A new stream (another scale, display or size) starts from a
            // scaled frame that is empty or stale, so it is drawn in full
            // even when the capture saw no change: a still KMS screen reports
            // none, which sent a black keyframe at every scale below 100%.
            if new_stream || damage != Damage::None {
                scale::downscale(source, &mut self.scaled);
            }
            if new_stream {
                Damage::Unknown
            } else {
                scale::scale_damage(&damage, (source.width, source.height), (width, height))
            }
        } else {
            damage
        };
        let frame = if scaled { &self.scaled } else { source };

        let size_changed = self
            .stream
            .is_some_and(|old| (old.width, old.height) != (width, height));
        let encoded = self
            .encoder
            .encode(frame, &damage, keyframe || new_stream, quality)
            .map_err(|e| e.0)?;
        self.figures.encodes += 1;
        self.figures.encode_time += encoding.elapsed();
        if encoded.tiles.is_empty() && !encoded.keyframe {
            return Ok(None);
        }
        if new_stream {
            out.push(text(AgentMessage::Stream {
                display: view_id(capturer.displays(), key.view),
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
            display: key.wire_display(),
            seq: self.seq,
            pts,
            width: width as u16,
            height: height as u16,
            keyframe: encoded.keyframe,
            size_changed,
        };
        for batch in frame::tile_batches(info, &encoded.tiles, frame::MAX_BATCH_BYTES) {
            self.figures.bytes_sent += batch.len() as u64;
            out.push(Outgoing::Binary(batch));
        }
        self.figures.frames_sent += 1;
        self.figures.tiles_sent += encoded.tiles.len() as u64;
        Ok(Some(SentFrame {
            seq: self.seq,
            keyframe: encoded.keyframe,
        }))
    }
}
