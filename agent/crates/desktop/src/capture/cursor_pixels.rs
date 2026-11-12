//! A Windows cursor's pixels from two renders, one over black and one over
//! white (SPEC-DESKTOP 19). Pure, so the tests run on every build machine;
//! the rendering is in `windows.rs`.
//!
//! Over black a pixel shows `c·a`; over white `c·a + (1 − a)`. So
//! `a = 1 − (white − black)`, and the colour is the black render divided by
//! `a`. A monochrome cursor's inverting pixels (AND 1, XOR 1, as in the text
//! I-beam) break that rule: white over black and black over white. The
//! browser cannot invert what is under the cursor, so they are drawn opaque
//! black with a one-pixel white outline, which shows on light and dark.

/// What one pixel of a cursor is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pixel {
    /// Nothing drawn.
    Transparent,
    /// A colour (straight, not premultiplied) and its alpha, above 0.
    Colour { rgb: [u8; 3], alpha: u8 },
    /// Inverts what is under it.
    Inverting,
}

/// How much brighter over black than over white a pixel must be to count
/// as inverting; ordinary pixels are never brighter over black.
const INVERTING_STEP: i32 = 128;

/// One pixel from its render over black and over white, each as BGR.
pub fn classify(black: [u8; 3], white: [u8; 3]) -> Pixel {
    let level = |bgr: [u8; 3]| bgr.iter().map(|&v| i32::from(v)).sum::<i32>() / 3;
    if level(black) - level(white) >= INVERTING_STEP {
        return Pixel::Inverting;
    }
    // Green is representative for the alpha.
    let alpha = 255 - (i32::from(white[1]) - i32::from(black[1])).clamp(0, 255);
    if alpha == 0 {
        return Pixel::Transparent;
    }
    let channel = |value: u8| ((i32::from(value) * 255 + alpha / 2) / alpha).min(255) as u8;
    Pixel::Colour {
        rgb: [channel(black[2]), channel(black[1]), channel(black[0])],
        alpha: alpha as u8,
    }
}

/// The cursor as straight RGBA rows from its renders over black and over
/// white (BGRA rows, `width` × `height`). Inverting pixels come out opaque
/// black; transparent pixels touching one (in any of the eight directions)
/// come out opaque white, the outline.
pub fn cursor_rgba(on_black: &[u8], on_white: &[u8], width: usize, height: usize) -> Vec<u8> {
    let pixels: Vec<Pixel> = on_black
        .chunks_exact(4)
        .zip(on_white.chunks_exact(4))
        .take(width * height)
        .map(|(b, w)| classify([b[0], b[1], b[2]], [w[0], w[1], w[2]]))
        .collect();
    let at = |x: usize, y: usize| pixels.get(y * width + x).copied();
    let touches_inverting = |x: usize, y: usize| {
        (y.saturating_sub(1)..=(y + 1).min(height.saturating_sub(1))).any(|ny| {
            (x.saturating_sub(1)..=(x + 1).min(width.saturating_sub(1)))
                .any(|nx| at(nx, ny) == Some(Pixel::Inverting))
        })
    };
    let mut rgba = Vec::with_capacity(pixels.len() * 4);
    for (index, pixel) in pixels.iter().enumerate() {
        let (x, y) = (index % width.max(1), index / width.max(1));
        let out = match pixel {
            Pixel::Inverting => [0, 0, 0, 255],
            Pixel::Transparent if touches_inverting(x, y) => [255, 255, 255, 255],
            Pixel::Transparent => [0, 0, 0, 0],
            Pixel::Colour { rgb, alpha } => [rgb[0], rgb[1], rgb[2], *alpha],
        };
        rgba.extend_from_slice(&out);
    }
    rgba
}

#[cfg(test)]
mod tests {
    use super::*;

    const BLACK: [u8; 3] = [0, 0, 0];
    const WHITE: [u8; 3] = [255, 255, 255];

    /// SPEC-DESKTOP CU1.
    #[test]
    fn cursor_pixels_are_classified() {
        // Transparent: the background shows through both renders.
        assert_eq!(classify(BLACK, WHITE), Pixel::Transparent);
        // Opaque: the same over black and over white (BGR in, RGB out).
        assert_eq!(
            classify([10, 20, 200], [10, 20, 200]),
            Pixel::Colour {
                rgb: [200, 20, 10],
                alpha: 255
            }
        );
        assert_eq!(
            classify(BLACK, BLACK),
            Pixel::Colour {
                rgb: [0, 0, 0],
                alpha: 255
            }
        );
        // Half-transparent white: 128 over black, 255 over white.
        assert_eq!(
            classify([128, 128, 128], WHITE),
            Pixel::Colour {
                rgb: [255, 255, 255],
                alpha: 128
            }
        );
        // Inverting: white over black, black over white.
        assert_eq!(classify(WHITE, BLACK), Pixel::Inverting);
        assert_eq!(classify([200, 200, 200], [40, 40, 40]), Pixel::Inverting);
    }

    fn bgra(rows: &[&[[u8; 3]]]) -> Vec<u8> {
        rows.iter()
            .flat_map(|row| row.iter())
            .flat_map(|&[b, g, r]| [b, g, r, 0])
            .collect()
    }

    /// SPEC-DESKTOP CU2.
    #[test]
    fn inverting_cursors_are_black_with_a_white_outline() {
        // A 4×3 cursor: one inverting pixel at (1, 1), an opaque red pixel
        // at (3, 0), the rest transparent.
        let red = [0, 0, 255];
        let on_black = bgra(&[
            &[BLACK, BLACK, BLACK, red],
            &[BLACK, WHITE, BLACK, BLACK],
            &[BLACK, BLACK, BLACK, BLACK],
        ]);
        let on_white = bgra(&[
            &[WHITE, WHITE, WHITE, red],
            &[WHITE, BLACK, WHITE, WHITE],
            &[WHITE, WHITE, WHITE, WHITE],
        ]);
        let rgba = cursor_rgba(&on_black, &on_white, 4, 3);
        let pixel = |x: usize, y: usize| &rgba[(y * 4 + x) * 4..(y * 4 + x) * 4 + 4];
        assert_eq!(pixel(1, 1), [0, 0, 0, 255], "inverting is opaque black");
        for (x, y) in [
            (0, 0),
            (1, 0),
            (2, 0),
            (0, 1),
            (2, 1),
            (0, 2),
            (1, 2),
            (2, 2),
        ] {
            assert_eq!(pixel(x, y), [255, 255, 255, 255], "outline at ({x}, {y})");
        }
        assert_eq!(pixel(3, 0), [255, 0, 0, 255], "opaque colour is kept");
        for (x, y) in [(3, 1), (3, 2)] {
            assert_eq!(pixel(x, y), [0, 0, 0, 0], "transparent at ({x}, {y})");
        }

        // An ordinary cursor gets no outline.
        let rgba = cursor_rgba(
            &bgra(&[&[BLACK, red], &[BLACK, BLACK]]),
            &bgra(&[&[WHITE, red], &[WHITE, WHITE]]),
            2,
            2,
        );
        assert_eq!(
            rgba,
            [0, 0, 0, 0, 255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0],
            "no outline without inverting pixels"
        );
    }
}
