//! The Windows tray's icon (SPEC-BRAND-ICON): the BMuster mark from
//! `assets/bmuster.ico` at the notification area's size, and the same mark
//! with the red dot while someone is connected to the screen
//! (SPEC-DESKTOP 8.2). The result is icon resource bits, which
//! `CreateIconFromResourceEx` turns into an icon; the Win32 call is in
//! `windows.rs`.

use super::ico::{images, Image};

/// The program's icon file, drawn from docs/logo.svg by `npm run icons:generate`.
pub const ICO: &[u8] = include_bytes!("../../assets/bmuster.ico");

/// `BITMAPINFOHEADER`'s size: the start of a DIB image's pixels.
const HEADER: usize = 40;

fn is_dib(image: &Image<'_>) -> bool {
    image.data.get(..4) == Some(&[40, 0, 0, 0])
}

/// The DIB image for an icon `edge` pixels square: that size, else the
/// next larger, else the largest (Windows scales it).
fn pick<'a>(found: &[Image<'a>], edge: u32) -> Option<Image<'a>> {
    let mut dibs: Vec<Image<'a>> = found.iter().copied().filter(is_dib).collect();
    dibs.sort_by_key(|image| image.edge);
    dibs.iter()
        .find(|image| image.edge >= edge)
        .or(dibs.last())
        .copied()
}

/// A 32-bit DIB's pixels as top-down ARGB in network order (the tray's
/// pixel format on Linux, which [`super::connected::connected_icon`] marks).
fn dib_to_argb(image: &Image<'_>) -> Result<Vec<u8>, String> {
    let edge = image.edge as usize;
    let row = edge * 4;
    let pixels = image
        .data
        .get(HEADER..HEADER + row * edge)
        .ok_or_else(|| format!("the {edge}px icon is cut short"))?;
    if image.data.get(14..16) != Some(&[32, 0]) {
        return Err(format!("the {edge}px icon is not 32-bit"));
    }
    let mut argb = Vec::with_capacity(row * edge);
    // A DIB's rows run bottom-up; each pixel is B, G, R, A.
    for line in pixels.chunks_exact(row).rev() {
        for pixel in line.chunks_exact(4) {
            argb.extend([pixel[3], pixel[2], pixel[1], pixel[0]]);
        }
    }
    Ok(argb)
}

/// Writes top-down ARGB pixels back into `image`'s DIB, keeping its header
/// and mask.
fn argb_to_dib(image: &Image<'_>, argb: &[u8]) -> Vec<u8> {
    let edge = image.edge as usize;
    let row = edge * 4;
    let mut dib = image.data.to_vec();
    for (y, line) in argb.chunks_exact(row).enumerate() {
        let start = HEADER + (edge - 1 - y) * row;
        for (x, pixel) in line.chunks_exact(4).enumerate() {
            if let Some(out) = dib.get_mut(start + x * 4..start + x * 4 + 4) {
                out.copy_from_slice(&[pixel[3], pixel[2], pixel[1], pixel[0]]);
            }
        }
    }
    dib
}

/// The tray icon's resource bits for a notification area `edge` pixels
/// square (the image of that size or the next larger), with the red dot
/// when someone is connected.
pub fn tray_icon(edge: u32, connected: bool) -> Result<Vec<u8>, String> {
    let found = images(ICO)?;
    let image = pick(&found, edge).ok_or("bmuster.ico has no DIB image")?;
    if !connected {
        return Ok(image.data.to_vec());
    }
    let side = i32::try_from(image.edge).map_err(|e| e.to_string())?;
    let marked = super::connected::connected_icon(side, &dib_to_argb(&image)?);
    Ok(argb_to_dib(&image, &marked))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// SPEC-BRAND-ICON W3: the tray picks the notification area's size (16px
    /// at 100%, 24px at 150%, 32px at 200%) or the next larger.
    #[test]
    fn the_tray_picks_its_size_from_the_icon() {
        let found = images(ICO).unwrap();
        let picked = |edge| pick(&found, edge).unwrap().edge;
        assert_eq!(picked(16), 16);
        assert_eq!(picked(20), 20);
        assert_eq!(picked(24), 24);
        assert_eq!(picked(28), 32);
        assert_eq!(picked(32), 32);
        assert_eq!(picked(64), 64);
        assert_eq!(picked(96), 64, "the PNG is never picked");
        assert_eq!(picked(1), 16);
    }

    /// SPEC-BRAND-ICON W4: the connected icon is the same mark with the red
    /// dot, and the 32px DIB holds the same pixels as the Linux tray's.
    #[test]
    fn the_connected_tray_icon_adds_the_red_dot() {
        let edge = 32;
        let plain = tray_icon(edge, false).unwrap();
        let image = Image { edge, data: &plain };
        let argb = dib_to_argb(&image).unwrap();
        assert_eq!(
            argb,
            include_bytes!("../../assets/tray-32.argb"),
            "one drawing"
        );
        assert_eq!(argb_to_dib(&image, &argb), plain, "round trip");

        let marked = tray_icon(edge, true).unwrap();
        assert_eq!(marked.len(), plain.len());
        let marked = dib_to_argb(&Image {
            edge,
            data: &marked,
        })
        .unwrap();
        assert_eq!(marked, super::super::connected::connected_icon(32, &argb));
        let at = |x: usize, y: usize| (y * 32 + x) * 4;
        assert_eq!(
            &marked[at(24, 24)..at(24, 24) + 4],
            &[255, 0xDC, 0x26, 0x26]
        );
        assert_eq!(
            &marked[at(16, 16)..at(16, 16) + 4],
            &argb[at(16, 16)..at(16, 16) + 4]
        );
    }
}
