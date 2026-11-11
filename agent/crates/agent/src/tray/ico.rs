//! Reads a Windows icon file (`.ico`): a directory of square images, each a
//! PNG or a 32-bit DIB. `npm run icons:generate` writes `assets/bmuster.ico`;
//! the build script makes the program's icon resource from it and the
//! Windows tray draws from it (SPEC-BRAND-ICON). Also compiled into
//! `build.rs`, so it uses only `core` and `std`.

/// One image in an icon file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Image<'a> {
    /// Its width and height in pixels.
    pub edge: u32,
    /// The image itself: PNG, or a DIB (header, colour pixels, mask).
    pub data: &'a [u8],
}

fn u16_at(bytes: &[u8], at: usize) -> Result<u16, String> {
    match bytes.get(at..at + 2) {
        Some(&[a, b]) => Ok(u16::from_le_bytes([a, b])),
        _ => Err(format!("the icon ends before byte {at}")),
    }
}

fn u32_at(bytes: &[u8], at: usize) -> Result<u32, String> {
    match bytes.get(at..at + 4) {
        Some(&[a, b, c, d]) => Ok(u32::from_le_bytes([a, b, c, d])),
        _ => Err(format!("the icon ends before byte {at}")),
    }
}

/// The images in `ico`, in file order. Every image must be square and lie
/// inside the file.
pub fn images(ico: &[u8]) -> Result<Vec<Image<'_>>, String> {
    if u16_at(ico, 0)? != 0 || u16_at(ico, 2)? != 1 {
        return Err("not an icon file".into());
    }
    let count = usize::from(u16_at(ico, 4)?);
    if count == 0 {
        return Err("the icon has no images".into());
    }
    (0..count)
        .map(|index| {
            let entry = 6 + index * 16;
            let edge = |byte: u8| if byte == 0 { 256 } else { u32::from(byte) };
            let (width, height) = match ico.get(entry..entry + 2) {
                Some(&[width, height]) => (edge(width), edge(height)),
                _ => return Err(format!("image {index}'s entry is cut short")),
            };
            if width != height {
                return Err(format!("image {index} is {width}x{height}, not square"));
            }
            let size = u32_at(ico, entry + 8)? as usize;
            let offset = u32_at(ico, entry + 12)? as usize;
            let data = offset
                .checked_add(size)
                .and_then(|end| ico.get(offset..end))
                .ok_or_else(|| format!("image {index} lies outside the file"))?;
            Ok(Image { edge: width, data })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// SPEC-BRAND-ICON W1: the committed icon has every Windows size.
    #[test]
    fn the_windows_icon_has_every_size() {
        let ico = include_bytes!("../../assets/bmuster.ico");
        let found = images(ico).unwrap();
        let edges: Vec<u32> = found.iter().map(|image| image.edge).collect();
        assert_eq!(edges, [16, 20, 24, 32, 40, 48, 64, 256]);
        for image in &found {
            let png = image.data.starts_with(b"\x89PNG\r\n\x1a\n");
            assert_eq!(
                png,
                image.edge == 256,
                "{}px is a PNG only at 256",
                image.edge
            );
        }
    }

    #[test]
    fn a_damaged_icon_is_refused() {
        assert!(images(b"").is_err());
        assert!(images(&[0, 0, 2, 0, 1, 0]).is_err(), "a cursor file");
        assert!(images(&[0, 0, 1, 0, 0, 0]).is_err(), "no images");
        let mut one = vec![0, 0, 1, 0, 1, 0];
        one.extend([16, 16, 0, 0, 1, 0, 32, 0]);
        one.extend(4u32.to_le_bytes());
        one.extend(22u32.to_le_bytes());
        one.extend([1, 2, 3, 4]);
        assert_eq!(
            images(&one).unwrap(),
            [Image {
                edge: 16,
                data: &[1, 2, 3, 4]
            }]
        );
        let mut outside = one.clone();
        outside.truncate(24);
        assert!(images(&outside).is_err(), "data past the end");
        let mut oblong = one;
        oblong[7] = 32;
        assert!(images(&oblong).is_err(), "16x32");
    }
}
