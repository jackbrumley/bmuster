//! A minimal PNG writer for cursor shapes (SPEC-DESKTOP 4.2).
//!
//! Cursors are small (usually 32×32 or 48×48) and sent once per shape, so the
//! image data goes in uncompressed ("stored") deflate blocks. That keeps a
//! compression library out of the agent for a few kilobytes per shape.

/// Encodes straight-alpha RGBA pixels as a PNG.
pub fn encode_rgba(width: u32, height: u32, rgba: &[u8]) -> Vec<u8> {
    assert_eq!(rgba.len(), width as usize * height as usize * 4);
    let row_len = width as usize * 4;
    let mut raw = Vec::with_capacity(rgba.len() + height as usize);
    for row in rgba.chunks_exact(row_len.max(1)).take(height as usize) {
        raw.push(0); // filter: none
        raw.extend_from_slice(row);
    }

    let mut out = Vec::with_capacity(raw.len() + 128);
    out.extend_from_slice(b"\x89PNG\r\n\x1a\n");

    let mut header = Vec::with_capacity(13);
    header.extend_from_slice(&width.to_be_bytes());
    header.extend_from_slice(&height.to_be_bytes());
    header.extend_from_slice(&[8, 6, 0, 0, 0]); // 8-bit RGBA, deflate, no interlace
    chunk(&mut out, b"IHDR", &header);
    chunk(&mut out, b"IDAT", &zlib_stored(&raw));
    chunk(&mut out, b"IEND", &[]);
    out
}

fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend_from_slice(&(data.len() as u32).to_be_bytes());
    let start = out.len();
    out.extend_from_slice(kind);
    out.extend_from_slice(data);
    let crc = crc32(&out[start..]);
    out.extend_from_slice(&crc.to_be_bytes());
}

fn zlib_stored(data: &[u8]) -> Vec<u8> {
    const MAX_BLOCK: usize = 0xFFFF;
    let mut out = Vec::with_capacity(data.len() + data.len() / MAX_BLOCK * 5 + 11);
    out.extend_from_slice(&[0x78, 0x01]);
    let mut blocks = data.chunks(MAX_BLOCK).peekable();
    if blocks.peek().is_none() {
        out.extend_from_slice(&[1, 0, 0, 0xFF, 0xFF]);
    }
    while let Some(block) = blocks.next() {
        out.push(u8::from(blocks.peek().is_none()));
        let len = block.len() as u16;
        out.extend_from_slice(&len.to_le_bytes());
        out.extend_from_slice(&(!len).to_le_bytes());
        out.extend_from_slice(block);
    }
    out.extend_from_slice(&adler32(data).to_be_bytes());
    out
}

fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &byte in data {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            crc = if crc & 1 == 1 {
                (crc >> 1) ^ 0xEDB8_8320
            } else {
                crc >> 1
            };
        }
    }
    !crc
}

fn adler32(data: &[u8]) -> u32 {
    let (mut a, mut b) = (1u32, 0u32);
    for chunk in data.chunks(5552) {
        for &byte in chunk {
            a += u32::from(byte);
            b += a;
        }
        a %= 65521;
        b %= 65521;
    }
    (b << 16) | a
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn png_round_trips_through_a_real_decoder() {
        // 200x100 is over one stored block (64 KB), so block splitting is covered.
        let (width, height) = (200u32, 100u32);
        let rgba: Vec<u8> = (0..width * height * 4)
            .map(|i| (i * 31 % 256) as u8)
            .collect();
        let png = encode_rgba(width, height, &rgba);

        let decoder = png::Decoder::new(std::io::Cursor::new(png));
        let mut reader = decoder.read_info().unwrap();
        let mut buffer = vec![0; reader.output_buffer_size().unwrap()];
        let info = reader.next_frame(&mut buffer).unwrap();
        assert_eq!((info.width, info.height), (width, height));
        assert_eq!(info.color_type, png::ColorType::Rgba);
        assert_eq!(&buffer[..info.buffer_size()], rgba.as_slice());
    }

    #[test]
    fn png_checksums_match_known_values() {
        assert_eq!(crc32(b"IEND"), 0xAE42_6082);
        assert_eq!(adler32(b"Wikipedia"), 0x11E6_0398);
    }
}
