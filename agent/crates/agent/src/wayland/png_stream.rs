//! PNG stream framing from the isolated GStreamer process, with fixed limits.
use anyhow::{bail, Result};
use std::io::Read;

pub fn read_png(mut input: impl Read) -> Result<Vec<u8>> {
    let mut signature = [0; 8];
    input.read_exact(&mut signature)?;
    if signature != *b"\x89PNG\r\n\x1a\n" {
        bail!("Capture returned an invalid PNG signature");
    }
    let mut bytes = signature.to_vec();
    loop {
        let mut header = [0; 8];
        input.read_exact(&mut header)?;
        let length = u32::from_be_bytes(header[..4].try_into()?) as usize;
        if length > super::wire::MAX_PACKET - 12
            || bytes.len() > super::wire::MAX_PACKET - length - 12
        {
            bail!("Capture frame exceeds its size limit");
        }
        bytes.extend_from_slice(&header);
        let start = bytes.len();
        bytes.resize(start + length + 4, 0);
        input.read_exact(&mut bytes[start..])?;
        if &header[4..] == b"IEND" {
            break;
        }
    }
    Ok(bytes)
}

pub fn decode(bytes: &[u8]) -> Result<bmuster_desktop::capture::Frame> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    decoder.set_limits(png::Limits {
        bytes: 64 * 1024 * 1024,
    });
    decoder.set_transformations(png::Transformations::normalize_to_color8());
    let mut reader = decoder.read_info()?;
    let (width, height) = (reader.info().width, reader.info().height);
    if width == 0
        || height == 0
        || width > 8192
        || height > 8192
        || u64::from(width) * u64::from(height) > 16 * 1024 * 1024
    {
        bail!("Unsupported capture dimensions");
    }
    let size = reader
        .output_buffer_size()
        .filter(|size| *size <= 64 * 1024 * 1024)
        .ok_or_else(|| anyhow::anyhow!("Invalid capture buffer size"))?;
    let mut data = vec![0; size];
    let info = reader.next_frame(&mut data)?;
    let channels = match info.color_type {
        png::ColorType::Rgb => 3,
        png::ColorType::Rgba => 4,
        _ => bail!("Capture must be RGB or RGBA"),
    };
    if info.buffer_size() != width as usize * height as usize * channels {
        bail!("Mismatched capture buffer length");
    }
    let mut frame = bmuster_desktop::capture::Frame::new(width, height);
    for (from, to) in data[..info.buffer_size()]
        .chunks_exact(channels)
        .zip(frame.data.chunks_exact_mut(4))
    {
        to.copy_from_slice(&[from[2], from[1], from[0], 0]);
    }
    Ok(frame)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validate_and_bound_frames() {
        assert!(read_png(b"not a PNG".as_slice()).is_err());
        let mut oversized = b"\x89PNG\r\n\x1a\n".to_vec();
        oversized.extend_from_slice(&u32::MAX.to_be_bytes());
        oversized.extend_from_slice(b"IDAT");
        assert!(read_png(oversized.as_slice()).is_err());
        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut bytes, 2, 1);
            encoder.set_color(png::ColorType::Rgb);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().unwrap();
            writer.write_image_data(&[255, 2, 3, 4, 5, 6]).unwrap();
        }
        let mut concatenated = bytes.clone();
        concatenated.extend_from_slice(&bytes);
        let mut cursor = std::io::Cursor::new(concatenated);
        assert_eq!(read_png(&mut cursor).unwrap(), bytes);
        assert_eq!(read_png(&mut cursor).unwrap(), bytes);
        let frame = decode(&bytes).unwrap();
        assert_eq!(frame.data, [3, 2, 255, 0, 6, 5, 4, 0]);
        assert!(decode(&bytes[..bytes.len() / 2]).is_err());
    }
}
