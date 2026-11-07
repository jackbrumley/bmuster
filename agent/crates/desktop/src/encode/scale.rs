//! Downscaling for the `scale` setting (SPEC-DESKTOP 5.1): each output pixel
//! is the average of the input pixels it covers.

use crate::capture::{Damage, Frame, Rect};

/// Output size for a display scaled by `factor` (at most 1), at least 1×1.
pub fn scaled_size(width: u32, height: u32, factor: f64) -> (u32, u32) {
    let factor = factor.clamp(0.01, 1.0);
    (
        ((f64::from(width) * factor).round() as u32).max(1),
        ((f64::from(height) * factor).round() as u32).max(1),
    )
}

/// Scales `source` down into `target` (whose size is already set).
pub fn downscale(source: &Frame, target: &mut Frame) {
    let (sw, sh) = (source.width as usize, source.height as usize);
    let (tw, th) = (target.width as usize, target.height as usize);
    for ty in 0..th {
        let y0 = ty * sh / th;
        let y1 = ((ty + 1) * sh / th).max(y0 + 1).min(sh);
        let row = target.row_mut(ty as u32);
        for tx in 0..tw {
            let x0 = tx * sw / tw;
            let x1 = ((tx + 1) * sw / tw).max(x0 + 1).min(sw);
            let mut sum = [0u32; 3];
            for y in y0..y1 {
                let source_row = source.row(y as u32);
                for pixel in source_row[x0 * 4..x1 * 4].chunks_exact(4) {
                    sum[0] += u32::from(pixel[0]);
                    sum[1] += u32::from(pixel[1]);
                    sum[2] += u32::from(pixel[2]);
                }
            }
            let count = ((y1 - y0) * (x1 - x0)) as u32;
            row[tx * 4..tx * 4 + 4].copy_from_slice(&[
                (sum[0] / count) as u8,
                (sum[1] / count) as u8,
                (sum[2] / count) as u8,
                0,
            ]);
        }
    }
}

/// Damage in display pixels mapped to the scaled frame, grown to whole pixels.
pub fn scale_damage(damage: &Damage, source: (u32, u32), target: (u32, u32)) -> Damage {
    let Damage::Rects(rects) = damage else {
        return damage.clone();
    };
    let map = |value: i64, from: u32, to: u32| value * i64::from(to) / i64::from(from.max(1));
    Damage::Rects(
        rects
            .iter()
            .map(|r| {
                let left = map(i64::from(r.x), source.0, target.0);
                let top = map(i64::from(r.y), source.1, target.1);
                let right = map(i64::from(r.x) + i64::from(r.width), source.0, target.0) + 1;
                let bottom = map(i64::from(r.y) + i64::from(r.height), source.1, target.1) + 1;
                Rect::new(
                    left as i32,
                    top as i32,
                    (right - left) as u32,
                    (bottom - top) as u32,
                )
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scale_halves_by_averaging() {
        let mut source = Frame::new(4, 2);
        source.fill(Rect::new(0, 0, 1, 2), [200, 100, 0, 0]);
        let (w, h) = scaled_size(4, 2, 0.5);
        assert_eq!((w, h), (2, 1));
        let mut target = Frame::new(w, h);
        downscale(&source, &mut target);
        assert_eq!(&target.row(0)[..8], &[100, 50, 0, 0, 0, 0, 0, 0]);
    }

    #[test]
    fn scale_damage_covers_the_scaled_area() {
        let damage = Damage::Rects(vec![Rect::new(10, 10, 3, 3)]);
        let Damage::Rects(rects) = scale_damage(&damage, (100, 100), (50, 50)) else {
            panic!("expected rects");
        };
        assert_eq!(rects, vec![Rect::new(5, 5, 2, 2)]);
    }
}
