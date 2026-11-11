//! The phase 1 video: a 64×64 tile grid, sending only tiles that changed
//! (SPEC-DESKTOP 4.2, R6).
//!
//! The encoder keeps a copy of what the browser has, so a tile is sent only
//! when its pixels differ from that copy. Damage rectangles from the platform
//! narrow the search; the pixel comparison decides. A tile of one colour goes
//! as 4 bytes instead of a JPEG.

use crate::capture::{Damage, Frame, Rect, BYTES_PER_PIXEL};
use crate::frame::{Tile, TileData};

/// Tile edge in pixels.
pub const TILE_SIZE: u32 = 64;

/// The encoded tiles of one frame.
#[derive(Debug)]
pub struct EncodedFrame {
    pub tiles: Vec<Tile>,
    /// True when the tiles cover the whole frame.
    pub keyframe: bool,
}

#[derive(Debug)]
pub struct EncodeError(pub String);

impl std::fmt::Display for EncodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for EncodeError {}

/// Tile diff and JPEG encoder for one stream.
#[derive(Default)]
pub struct TileEncoder {
    /// What the browser shows now, or `None` before the first keyframe.
    shown: Option<Frame>,
    scratch: Vec<u8>,
}

impl TileEncoder {
    pub fn new() -> Self {
        TileEncoder::default()
    }

    /// Forgets what the browser shows, so the next frame is a keyframe.
    pub fn reset(&mut self) {
        self.shown = None;
    }

    /// Encodes the tiles of `frame` that differ from what the browser shows.
    ///
    /// A keyframe (asked for, the first frame, or a new size) covers every
    /// tile. Otherwise only tiles touched by `damage` are compared, or every
    /// tile when the damage is [`Damage::Unknown`].
    pub fn encode(
        &mut self,
        frame: &Frame,
        damage: &Damage,
        keyframe: bool,
        quality: u8,
    ) -> Result<EncodedFrame, EncodeError> {
        let same_size = self
            .shown
            .as_ref()
            .is_some_and(|shown| shown.width == frame.width && shown.height == frame.height);
        let keyframe = keyframe || !same_size;
        if !keyframe && *damage == Damage::None {
            return Ok(EncodedFrame {
                tiles: Vec::new(),
                keyframe,
            });
        }
        let shown = match &mut self.shown {
            Some(shown) if same_size => shown,
            slot => slot.insert(Frame::new(frame.width, frame.height)),
        };

        let mut tiles = Vec::new();
        for tile_y in (0..frame.height).step_by(TILE_SIZE as usize) {
            for tile_x in (0..frame.width).step_by(TILE_SIZE as usize) {
                let rect = Rect::new(
                    tile_x as i32,
                    tile_y as i32,
                    TILE_SIZE.min(frame.width - tile_x),
                    TILE_SIZE.min(frame.height - tile_y),
                );
                if !keyframe {
                    if let Damage::Rects(rects) = damage {
                        if !rects.iter().any(|r| r.intersect(&rect).is_some()) {
                            continue;
                        }
                    }
                    if same_pixels(frame, shown, rect) {
                        continue;
                    }
                }
                let data = match solid_colour(frame, rect) {
                    Some(bgrx) => TileData::Solid([bgrx[2], bgrx[1], bgrx[0], 255]),
                    None => TileData::Jpeg(encode_jpeg(frame, rect, quality, &mut self.scratch)?),
                };
                copy_rect(frame, shown, rect);
                tiles.push(Tile {
                    x: rect.x as u16,
                    y: rect.y as u16,
                    w: rect.width as u16,
                    h: rect.height as u16,
                    data,
                });
            }
        }
        Ok(EncodedFrame { tiles, keyframe })
    }
}

fn row_range(rect: Rect) -> std::ops::Range<usize> {
    let start = rect.x as usize * BYTES_PER_PIXEL;
    start..start + rect.width as usize * BYTES_PER_PIXEL
}

fn same_pixels(a: &Frame, b: &Frame, rect: Rect) -> bool {
    let range = row_range(rect);
    (rect.y as u32..rect.y as u32 + rect.height)
        .all(|y| a.row(y)[range.clone()] == b.row(y)[range.clone()])
}

fn copy_rect(from: &Frame, to: &mut Frame, rect: Rect) {
    let range = row_range(rect);
    for y in rect.y as u32..rect.y as u32 + rect.height {
        to.row_mut(y)[range.clone()].copy_from_slice(&from.row(y)[range.clone()]);
    }
}

/// The tile's colour when every pixel has the same blue, green and red.
fn solid_colour(frame: &Frame, rect: Rect) -> Option<[u8; 4]> {
    let range = row_range(rect);
    let first = &frame.row(rect.y as u32)[range.start..range.start + 4];
    let colour = [first[0], first[1], first[2], 0];
    for y in rect.y as u32..rect.y as u32 + rect.height {
        let row = &frame.row(y)[range.clone()];
        if !row.chunks_exact(4).all(|pixel| pixel[..3] == colour[..3]) {
            return None;
        }
    }
    Some(colour)
}

/// From this quality up, colour keeps full detail (4:4:4).
pub const FULL_COLOUR_FROM: u8 = 85;

/// Colour detail for a JPEG quality: below [`FULL_COLOUR_FROM`] colour is
/// kept at half size each way (4:2:0), which smears coloured text and thin
/// lines on a desktop whatever the quality number; from it, full detail.
fn sampling_for(quality: u8) -> jpeg_encoder::SamplingFactor {
    if quality >= FULL_COLOUR_FROM {
        jpeg_encoder::SamplingFactor::R_4_4_4
    } else {
        jpeg_encoder::SamplingFactor::R_4_2_0
    }
}

fn encode_jpeg(
    frame: &Frame,
    rect: Rect,
    quality: u8,
    scratch: &mut Vec<u8>,
) -> Result<Vec<u8>, EncodeError> {
    let range = row_range(rect);
    scratch.clear();
    for y in rect.y as u32..rect.y as u32 + rect.height {
        scratch.extend_from_slice(&frame.row(y)[range.clone()]);
    }
    let mut out = Vec::with_capacity(4096);
    let mut encoder = jpeg_encoder::Encoder::new(&mut out, quality);
    encoder.set_sampling_factor(sampling_for(quality));
    encoder
        .encode(
            scratch,
            rect.width as u16,
            rect.height as u16,
            jpeg_encoder::ColorType::Bgra,
        )
        .map_err(|error| EncodeError(format!("JPEG encoding failed: {error}")))?;
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn high_qualities_keep_full_colour_detail() {
        assert!(matches!(sampling_for(84), jpeg_encoder::SamplingFactor::R_4_2_0));
        assert!(matches!(sampling_for(85), jpeg_encoder::SamplingFactor::R_4_4_4));
        assert!(matches!(sampling_for(95), jpeg_encoder::SamplingFactor::R_4_4_4));
    }

    const RED: [u8; 4] = [0, 0, 255, 0];
    const GREEN: [u8; 4] = [0, 255, 0, 0];

    /// A grey ramp across the tile, dark to light.
    fn gradient(frame: &mut Frame, rect: Rect) {
        for y in rect.y as u32..rect.y as u32 + rect.height {
            for x in rect.x as u32..rect.x as u32 + rect.width {
                let v = ((x - rect.x as u32) * 4) as u8;
                frame.row_mut(y)[x as usize * 4..x as usize * 4 + 4].copy_from_slice(&[v, v, v, 0]);
            }
        }
    }

    fn positions(encoded: &EncodedFrame) -> Vec<(u16, u16)> {
        encoded.tiles.iter().map(|t| (t.x, t.y)).collect()
    }

    #[test]
    fn tiles_first_frame_is_a_keyframe_covering_every_tile_with_smaller_edges() {
        let frame = Frame::new(130, 70);
        let mut encoder = TileEncoder::new();
        let encoded = encoder.encode(&frame, &Damage::None, false, 70).unwrap();
        assert!(encoded.keyframe);
        assert_eq!(
            encoded
                .tiles
                .iter()
                .map(|t| (t.x, t.y, t.w, t.h))
                .collect::<Vec<_>>(),
            vec![
                (0, 0, 64, 64),
                (64, 0, 64, 64),
                (128, 0, 2, 64),
                (0, 64, 64, 6),
                (64, 64, 64, 6),
                (128, 64, 2, 6)
            ]
        );
        assert!(encoded
            .tiles
            .iter()
            .all(|t| t.data == TileData::Solid([0, 0, 0, 255])));
    }

    #[test]
    fn tiles_only_changed_tiles_are_sent() {
        let mut frame = Frame::new(256, 256);
        let mut encoder = TileEncoder::new();
        encoder.encode(&frame, &Damage::Unknown, true, 70).unwrap();

        // A 10x10 change across the corner of four tiles.
        frame.fill(Rect::new(60, 60, 10, 10), RED);
        let encoded = encoder.encode(&frame, &Damage::Unknown, false, 70).unwrap();
        assert!(!encoded.keyframe);
        assert_eq!(
            positions(&encoded),
            vec![(0, 0), (64, 0), (0, 64), (64, 64)]
        );

        // Nothing changed since: nothing to send.
        let again = encoder.encode(&frame, &Damage::Unknown, false, 70).unwrap();
        assert!(again.tiles.is_empty());
    }

    #[test]
    fn tiles_damage_limits_the_search_and_none_skips_it() {
        let mut frame = Frame::new(256, 128);
        let mut encoder = TileEncoder::new();
        encoder.encode(&frame, &Damage::Unknown, true, 70).unwrap();
        frame.fill(Rect::new(0, 0, 256, 128), GREEN);

        let encoded = encoder
            .encode(
                &frame,
                &Damage::Rects(vec![Rect::new(130, 70, 5, 5)]),
                false,
                70,
            )
            .unwrap();
        assert_eq!(positions(&encoded), vec![(128, 64)]);
        assert!(encoder
            .encode(&frame, &Damage::None, false, 70)
            .unwrap()
            .tiles
            .is_empty());
        // The other tiles still differ and go out with the next keyframe.
        let key = encoder.encode(&frame, &Damage::None, true, 70).unwrap();
        assert_eq!(key.tiles.len(), 8);
    }

    #[test]
    fn tiles_solid_colour_is_rgba_and_detail_is_jpeg() {
        let mut frame = Frame::new(128, 64);
        frame.fill(Rect::new(0, 0, 64, 64), RED);
        gradient(&mut frame, Rect::new(64, 0, 64, 64));
        let encoded = TileEncoder::new()
            .encode(&frame, &Damage::Unknown, true, 80)
            .unwrap();
        assert_eq!(encoded.tiles[0].data, TileData::Solid([255, 0, 0, 255]));
        let TileData::Jpeg(jpeg) = &encoded.tiles[1].data else {
            panic!("expected a JPEG tile");
        };
        let mut decoder = zune_jpeg::JpegDecoder::new(std::io::Cursor::new(jpeg.as_slice()));
        let pixels = decoder.decode().unwrap();
        let info = decoder.info().unwrap();
        assert_eq!((info.width, info.height), (64, 64));
        // Pixel (32, 32) of the ramp is grey 128.
        let at = (32 * 64 + 32) * 3;
        for channel in &pixels[at..at + 3] {
            assert!((i32::from(*channel) - 128).abs() <= 8, "{channel}");
        }
    }

    #[test]
    fn tiles_new_size_forces_a_keyframe() {
        let mut encoder = TileEncoder::new();
        encoder
            .encode(&Frame::new(64, 64), &Damage::Unknown, true, 70)
            .unwrap();
        let encoded = encoder
            .encode(&Frame::new(128, 64), &Damage::None, false, 70)
            .unwrap();
        assert!(encoded.keyframe);
        assert_eq!(encoded.tiles.len(), 2);
    }

    #[test]
    fn tiles_reset_makes_the_next_frame_a_keyframe() {
        let frame = Frame::new(64, 64);
        let mut encoder = TileEncoder::new();
        encoder.encode(&frame, &Damage::Unknown, true, 70).unwrap();
        encoder.reset();
        let encoded = encoder.encode(&frame, &Damage::None, false, 70).unwrap();
        assert!(encoded.keyframe);
        assert_eq!(encoded.tiles.len(), 1);
    }
}
