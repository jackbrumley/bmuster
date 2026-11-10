//! Linear framebuffers to BGRX (SPEC-CONSOLE-CAPTURE, Capture 3).
//!
//! DRM formats are little-endian words named from the most significant
//! channel: `XRGB8888` is a `u32` of `0xXXRRGGBB`, so B, G, R, X in memory,
//! which is already what a [`Frame`] holds. Every other supported format is
//! converted; anything else is refused with its fourcc, never guessed.

use crate::capture::{Frame, Rect, BYTES_PER_PIXEL};

/// A fourcc code from its four characters (`drm_fourcc.h`'s `fourcc_code`).
pub const fn fourcc(code: &[u8; 4]) -> u32 {
    (code[0] as u32) | (code[1] as u32) << 8 | (code[2] as u32) << 16 | (code[3] as u32) << 24
}

pub const XRGB8888: u32 = fourcc(b"XR24");
pub const ARGB8888: u32 = fourcc(b"AR24");
pub const XBGR8888: u32 = fourcc(b"XB24");
pub const ABGR8888: u32 = fourcc(b"AB24");
pub const XRGB2101010: u32 = fourcc(b"XR30");
pub const ARGB2101010: u32 = fourcc(b"AR30");
pub const XBGR2101010: u32 = fourcc(b"XB30");
pub const ABGR2101010: u32 = fourcc(b"AB30");
pub const RGB565: u32 = fourcc(b"RG16");

/// `DRM_FORMAT_MOD_LINEAR`.
pub const MOD_LINEAR: u64 = 0;
/// `DRM_FORMAT_MOD_INVALID`: the buffer has no explicit modifier.
pub const MOD_INVALID: u64 = 0x00ff_ffff_ffff_ffff;

/// A fourcc as text, for messages (`XR24`, or hex when it is not printable).
pub fn fourcc_name(format: u32) -> String {
    let bytes = format.to_le_bytes();
    if bytes.iter().all(|b| b.is_ascii_graphic() || *b == b' ') {
        String::from_utf8_lossy(&bytes).trim_end().to_string()
    } else {
        format!("0x{format:08x}")
    }
}

/// Bytes per pixel of the formats [`convert`] reads, `None` for others.
pub fn bytes_per_pixel(format: u32) -> Option<usize> {
    match format {
        XRGB8888 | ARGB8888 | XBGR8888 | ABGR8888 | XRGB2101010 | ARGB2101010 | XBGR2101010
        | ABGR2101010 => Some(4),
        RGB565 => Some(2),
        _ => None,
    }
}

/// True when the format's fourth channel is alpha, not padding.
pub fn has_alpha(format: u32) -> bool {
    matches!(format, ARGB8888 | ABGR8888 | ARGB2101010 | ABGR2101010)
}

/// Where the pixels sit in a mapped buffer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BufferLayout {
    pub format: u32,
    /// Bytes per row.
    pub pitch: u32,
    /// Where the first row starts.
    pub offset: u32,
    /// The framebuffer's size.
    pub width: u32,
    pub height: u32,
}

/// Copies `crop` of a linear buffer into a BGRX frame of the crop's size.
/// Every bound is checked against `bytes` before a pixel is read.
pub fn convert(bytes: &[u8], layout: &BufferLayout, crop: Rect) -> Result<Frame, String> {
    let name = fourcc_name(layout.format);
    let bpp = bytes_per_pixel(layout.format)
        .ok_or_else(|| format!("The screen uses pixel format {name}, which BMuster cannot read"))?;
    if crop.width == 0 || crop.height == 0 || crop.x < 0 || crop.y < 0 {
        return Err("The screen area to copy is empty".to_string());
    }
    let (left, top) = (crop.x as u64, crop.y as u64);
    if left + u64::from(crop.width) > u64::from(layout.width)
        || top + u64::from(crop.height) > u64::from(layout.height)
    {
        return Err(format!(
            "The screen area {}x{}+{}+{} is outside the {}x{} framebuffer",
            crop.width, crop.height, crop.x, crop.y, layout.width, layout.height
        ));
    }
    let pitch = u64::from(layout.pitch);
    if pitch < u64::from(layout.width) * bpp as u64 {
        return Err(format!(
            "The framebuffer's pitch {} is narrower than {} pixels of {name}",
            layout.pitch, layout.width
        ));
    }
    let row_bytes = u64::from(crop.width) * bpp as u64;
    let last = u64::from(layout.offset)
        + (top + u64::from(crop.height) - 1) * pitch
        + left * bpp as u64
        + row_bytes;
    if last > bytes.len() as u64 {
        return Err(format!(
            "The framebuffer is too short: {} bytes for {last}",
            bytes.len()
        ));
    }
    let mut frame = Frame::new(crop.width, crop.height);
    for y in 0..crop.height {
        let start =
            (u64::from(layout.offset) + (top + u64::from(y)) * pitch + left * bpp as u64) as usize;
        let source = &bytes[start..start + row_bytes as usize];
        convert_row(layout.format, source, frame.row_mut(y));
    }
    Ok(frame)
}

/// One row; `source` and `target` hold the same number of pixels.
fn convert_row(format: u32, source: &[u8], target: &mut [u8]) {
    match format {
        XRGB8888 | ARGB8888 => target.copy_from_slice(source),
        XBGR8888 | ABGR8888 => {
            for (from, to) in source.chunks_exact(4).zip(target.chunks_exact_mut(4)) {
                to.copy_from_slice(&[from[2], from[1], from[0], from[3]]);
            }
        }
        XRGB2101010 | ARGB2101010 | XBGR2101010 | ABGR2101010 => {
            let red_high = matches!(format, XRGB2101010 | ARGB2101010);
            let alpha = has_alpha(format);
            for (from, to) in source
                .chunks_exact(4)
                .zip(target.chunks_exact_mut(BYTES_PER_PIXEL))
            {
                let word = u32::from_le_bytes([from[0], from[1], from[2], from[3]]);
                let channel = |shift: u32| ((word >> shift) & 0x3FF) as u16 >> 2;
                let (high, middle, low) = (channel(20) as u8, channel(10) as u8, channel(0) as u8);
                let (red, blue) = if red_high { (high, low) } else { (low, high) };
                // Two bits of alpha, 0 to 3, as 0 to 255.
                let a = if alpha { (word >> 30) as u8 * 85 } else { 0xFF };
                to.copy_from_slice(&[blue, middle, red, a]);
            }
        }
        RGB565 => {
            for (from, to) in source
                .chunks_exact(2)
                .zip(target.chunks_exact_mut(BYTES_PER_PIXEL))
            {
                let word = u16::from_le_bytes([from[0], from[1]]);
                let five = |v: u16| ((v << 3) | (v >> 2)) as u8;
                let six = |v: u16| ((v << 2) | (v >> 4)) as u8;
                to.copy_from_slice(&[
                    five(word & 0x1F),
                    six((word >> 5) & 0x3F),
                    five(word >> 11),
                    0xFF,
                ]);
            }
        }
        // `convert` refused every other format before reaching here.
        _ => target.fill(0),
    }
}

/// A premultiplied ARGB8888 cursor (what compositors put on the cursor
/// plane) to straight RGBA, `width` × `height` from a buffer of `pitch`.
pub fn cursor_rgba(bytes: &[u8], pitch: usize, width: u32, height: u32) -> Option<Vec<u8>> {
    let row = width as usize * 4;
    if width == 0 || height == 0 || pitch < row || bytes.len() < pitch * (height as usize - 1) + row
    {
        return None;
    }
    let mut rgba = Vec::with_capacity(row * height as usize);
    for y in 0..height as usize {
        for pixel in bytes[y * pitch..y * pitch + row].chunks_exact(4) {
            let (b, g, r, a) = (pixel[0], pixel[1], pixel[2], pixel[3]);
            let straight = |c: u8| {
                if a == 0 {
                    0
                } else {
                    ((u16::from(c) * 255 + u16::from(a) / 2) / u16::from(a)).min(255) as u8
                }
            };
            rgba.extend_from_slice(&[straight(r), straight(g), straight(b), a]);
        }
    }
    Some(rgba)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fourcc_names_and_cursor_alpha() {
        assert_eq!(fourcc_name(XRGB8888), "XR24");
        assert_eq!(fourcc_name(0x0102_0304), "0x01020304");
        // Half-transparent white, premultiplied, comes back straight.
        let rgba = cursor_rgba(&[0x80, 0x80, 0x80, 0x80, 0, 0, 0, 0], 8, 2, 1).unwrap();
        assert_eq!(rgba, vec![0xFF, 0xFF, 0xFF, 0x80, 0, 0, 0, 0]);
        assert!(cursor_rgba(&[0; 4], 4, 2, 1).is_none());
    }
}
