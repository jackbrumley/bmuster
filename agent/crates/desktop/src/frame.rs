//! The binary frame format (SPEC-DESKTOP 4.1 and 4.2).
//!
//! Every binary message from the agent starts with a 20-byte little-endian
//! header. Tile batches carry the encoded tiles of one frame, split over
//! several messages when the frame is large; cursor messages carry the shape
//! (once per new shape) and the position.

/// Format version in byte 3 of every header.
pub const FORMAT_VERSION: u8 = 1;
/// Length of the header in bytes.
pub const HEADER_LEN: usize = 20;
/// A tile batch stops growing once its payload passes this many bytes, so one
/// big frame never becomes one huge WebSocket message.
pub const MAX_BATCH_BYTES: usize = 256 * 1024;

/// What a binary message carries (byte 0).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MessageType {
    H264 = 1,
    TileBatch = 2,
    CursorShape = 3,
    CursorPosition = 4,
}

/// Header flag: the frame is a keyframe (covers the whole frame).
pub const FLAG_KEYFRAME: u8 = 1;
/// Header flag: the width and height are new.
pub const FLAG_SIZE_CHANGED: u8 = 1 << 1;
/// Header flag: the last batch of a frame; the browser draws and acks on it.
pub const FLAG_LAST_PART: u8 = 1 << 2;

/// The 20-byte header.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Header {
    pub kind: MessageType,
    /// Index into the current `displays` list.
    pub display: u8,
    pub flags: u8,
    /// Frame number; cursor messages carry the seq of the last frame.
    pub seq: u32,
    /// Capture time in microseconds since the session started.
    pub pts: u64,
    pub width: u16,
    pub height: u16,
}

impl Header {
    pub fn write(&self, out: &mut Vec<u8>) {
        out.push(self.kind as u8);
        out.push(self.display);
        out.push(self.flags);
        out.push(FORMAT_VERSION);
        out.extend_from_slice(&self.seq.to_le_bytes());
        out.extend_from_slice(&self.pts.to_le_bytes());
        out.extend_from_slice(&self.width.to_le_bytes());
        out.extend_from_slice(&self.height.to_le_bytes());
    }
}

/// How a tile's pixels are carried (SPEC-DESKTOP 4.2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TileData {
    Jpeg(Vec<u8>),
    /// One colour fills the tile: red, green, blue, alpha.
    Solid([u8; 4]),
}

impl TileData {
    fn format(&self) -> u8 {
        match self {
            TileData::Jpeg(_) => 1,
            TileData::Solid(_) => 3,
        }
    }

    fn bytes(&self) -> &[u8] {
        match self {
            TileData::Jpeg(bytes) => bytes,
            TileData::Solid(rgba) => rgba,
        }
    }
}

/// One encoded tile at its place in the frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tile {
    pub x: u16,
    pub y: u16,
    pub w: u16,
    pub h: u16,
    pub data: TileData,
}

impl Tile {
    /// Bytes this tile adds to a batch payload.
    fn encoded_len(&self) -> usize {
        13 + self.data.bytes().len()
    }

    fn write(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.x.to_le_bytes());
        out.extend_from_slice(&self.y.to_le_bytes());
        out.extend_from_slice(&self.w.to_le_bytes());
        out.extend_from_slice(&self.h.to_le_bytes());
        out.push(self.data.format());
        let bytes = self.data.bytes();
        // A 64x64 tile is far below 4 GB.
        out.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
        out.extend_from_slice(bytes);
    }
}

/// Header fields shared by every batch of one frame.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameInfo {
    pub display: u8,
    pub seq: u32,
    pub pts: u64,
    pub width: u16,
    pub height: u16,
    pub keyframe: bool,
    pub size_changed: bool,
}

/// Packs a frame's tiles into one or more tile-batch messages. The last
/// message has [`FLAG_LAST_PART`]; every message has the same seq. A frame
/// with no tiles still gives one (empty, last) batch, so a keyframe of an
/// empty frame is acknowledged like any other.
pub fn tile_batches(info: FrameInfo, tiles: &[Tile], max_batch_bytes: usize) -> Vec<Vec<u8>> {
    let mut groups: Vec<&[Tile]> = Vec::new();
    let mut start = 0;
    let mut size = 0;
    for (index, tile) in tiles.iter().enumerate() {
        let len = tile.encoded_len();
        let full = index > start && (size + len > max_batch_bytes || index - start == 0xFFFF);
        if full {
            groups.push(&tiles[start..index]);
            start = index;
            size = 0;
        }
        size += len;
    }
    groups.push(&tiles[start..]);

    let mut flags = 0;
    if info.keyframe {
        flags |= FLAG_KEYFRAME;
    }
    if info.size_changed {
        flags |= FLAG_SIZE_CHANGED;
    }
    let last = groups.len() - 1;
    groups
        .iter()
        .enumerate()
        .map(|(index, group)| {
            let header = Header {
                kind: MessageType::TileBatch,
                display: info.display,
                flags: if index == last {
                    flags | FLAG_LAST_PART
                } else {
                    flags
                },
                seq: info.seq,
                pts: info.pts,
                width: info.width,
                height: info.height,
            };
            let payload: usize = group.iter().map(Tile::encoded_len).sum();
            let mut out = Vec::with_capacity(HEADER_LEN + 2 + payload);
            header.write(&mut out);
            // Groups are cut at 0xFFFF tiles above.
            out.extend_from_slice(&(group.len() as u16).to_le_bytes());
            for tile in *group {
                tile.write(&mut out);
            }
            out
        })
        .collect()
}

/// Header fields of a cursor message: the display, the last frame's seq,
/// the time and the current encoded frame size.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CursorContext {
    pub display: u8,
    pub seq: u32,
    pub pts: u64,
    pub width: u16,
    pub height: u16,
}

impl CursorContext {
    fn header(&self, kind: MessageType) -> Header {
        Header {
            kind,
            display: self.display,
            flags: 0,
            seq: self.seq,
            pts: self.pts,
            width: self.width,
            height: self.height,
        }
    }
}

/// A cursor shape message: `id: u32, hotspotX: u16, hotspotY: u16`, then a PNG.
pub fn cursor_shape(context: CursorContext, id: u32, hotspot: (u16, u16), png: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(HEADER_LEN + 8 + png.len());
    context.header(MessageType::CursorShape).write(&mut out);
    out.extend_from_slice(&id.to_le_bytes());
    out.extend_from_slice(&hotspot.0.to_le_bytes());
    out.extend_from_slice(&hotspot.1.to_le_bytes());
    out.extend_from_slice(png);
    out
}

/// A cursor position message: `id: u32, x: i32, y: i32, visible: u8`, in
/// encoded-frame pixels.
pub fn cursor_position(context: CursorContext, id: u32, x: i32, y: i32, visible: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(HEADER_LEN + 13);
    context.header(MessageType::CursorPosition).write(&mut out);
    out.extend_from_slice(&id.to_le_bytes());
    out.extend_from_slice(&x.to_le_bytes());
    out.extend_from_slice(&y.to_le_bytes());
    out.push(u8::from(visible));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(keyframe: bool) -> FrameInfo {
        FrameInfo {
            display: 1,
            seq: 0x0102_0304,
            pts: 0x1122_3344_5566_7788,
            width: 1920,
            height: 1080,
            keyframe,
            size_changed: false,
        }
    }

    fn solid(x: u16) -> Tile {
        Tile {
            x,
            y: 0,
            w: 64,
            h: 64,
            data: TileData::Solid([1, 2, 3, 255]),
        }
    }

    #[test]
    fn frame_header_layout_is_little_endian_and_twenty_bytes() {
        let batches = tile_batches(info(true), &[], MAX_BATCH_BYTES);
        assert_eq!(batches.len(), 1);
        let bytes = &batches[0];
        assert_eq!(
            &bytes[..HEADER_LEN],
            &[
                2,
                1,
                FLAG_KEYFRAME | FLAG_LAST_PART,
                1,
                0x04,
                0x03,
                0x02,
                0x01,
                0x88,
                0x77,
                0x66,
                0x55,
                0x44,
                0x33,
                0x22,
                0x11,
                0x80,
                0x07,
                0x38,
                0x04
            ]
        );
        assert_eq!(&bytes[HEADER_LEN..], &[0, 0]);
    }

    #[test]
    fn frame_tile_entry_layout() {
        let tile = Tile {
            x: 64,
            y: 128,
            w: 32,
            h: 16,
            data: TileData::Jpeg(vec![0xFF, 0xD8]),
        };
        let batches = tile_batches(info(false), &[tile], MAX_BATCH_BYTES);
        assert_eq!(batches[0][2], FLAG_LAST_PART);
        assert_eq!(
            &batches[0][HEADER_LEN..],
            &[1, 0, 64, 0, 128, 0, 32, 0, 16, 0, 1, 2, 0, 0, 0, 0xFF, 0xD8]
        );
    }

    #[test]
    fn frame_split_batches_share_seq_and_only_last_has_last_flag() {
        let tiles: Vec<Tile> = (0..10).map(|i| solid(i * 64)).collect();
        // Each solid tile is 17 bytes; 40 bytes fits two per batch.
        let batches = tile_batches(info(true), &tiles, 40);
        assert_eq!(batches.len(), 5);
        for (index, batch) in batches.iter().enumerate() {
            assert_eq!(&batch[4..8], &0x0102_0304u32.to_le_bytes());
            assert_eq!(batch[2] & FLAG_KEYFRAME, FLAG_KEYFRAME);
            assert_eq!(batch[2] & FLAG_LAST_PART != 0, index == 4);
            assert_eq!(u16::from_le_bytes([batch[20], batch[21]]), 2);
        }
    }

    #[test]
    fn frame_cursor_messages() {
        let context = CursorContext {
            display: 0,
            seq: 7,
            pts: 9,
            width: 800,
            height: 600,
        };
        let shape = cursor_shape(context, 5, (3, 4), &[0x89, b'P']);
        assert_eq!(shape[0], 3);
        assert_eq!(&shape[HEADER_LEN..], &[5, 0, 0, 0, 3, 0, 4, 0, 0x89, b'P']);
        let position = cursor_position(context, 5, -2, 10, true);
        assert_eq!(position[0], 4);
        assert_eq!(
            &position[HEADER_LEN..],
            &[5, 0, 0, 0, 0xFE, 0xFF, 0xFF, 0xFF, 10, 0, 0, 0, 1]
        );
    }
}
