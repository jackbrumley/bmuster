//! Every display in one frame (SPEC-DESKTOP-ALL-SCREENS): the bounding box
//! of the displays' rectangles on the desktop, each display's image drawn
//! at its offset in it, and black wherever no display is. One frame pixel is
//! one desktop unit, so the pointer and cursor map to the desktop by adding
//! the box's corner, exactly as for one display.
//!
//! A display whose image is a different size from its rectangle (a high-DPI
//! KMS display laid out in mutter's logical pixels) is resampled into it.

use super::{bounds_of, DisplayInfo, Frame, Rect, BYTES_PER_PIXEL};
use crate::capture::Damage;
use crate::encode::scale;

/// Longest side of a combined frame, in pixels.
pub const MAX_SIDE: u32 = 16384;
/// Most pixels in a combined frame (256 MB of BGRX).
pub const MAX_PIXELS: u64 = 8192 * 8192;

/// The layout of a combined frame.
#[derive(Debug, Clone)]
pub struct Combined {
    bounds: Rect,
    /// Each display's place in the frame (relative to `bounds`).
    places: Vec<Rect>,
    /// A display's image resampled to its place, before it is copied in.
    scratch: Frame,
}

impl Combined {
    /// The layout of `displays` in one frame; `None` with fewer than two
    /// displays, or when the frame would be over [`MAX_SIDE`] or
    /// [`MAX_PIXELS`].
    pub fn new(displays: &[DisplayInfo]) -> Option<Combined> {
        if displays.len() < 2 {
            return None;
        }
        let bounds = bounds_of(displays);
        let pixels = u64::from(bounds.width) * u64::from(bounds.height);
        if bounds.width > MAX_SIDE || bounds.height > MAX_SIDE || pixels > MAX_PIXELS {
            return None;
        }
        Some(Combined {
            bounds,
            places: displays
                .iter()
                .map(|d| d.rect().offset(bounds.x, bounds.y))
                .collect(),
            scratch: Frame::new(0, 0),
        })
    }

    /// Whether `displays` can be shown in one frame.
    pub fn possible(displays: &[DisplayInfo]) -> bool {
        Combined::new(displays).is_some()
    }

    /// The frame's rectangle on the desktop.
    pub fn bounds(&self) -> Rect {
        self.bounds
    }

    /// Display `index`'s place in the frame.
    pub fn place(&self, index: usize) -> Option<Rect> {
        self.places.get(index).copied()
    }

    /// A black frame of the combined size.
    pub fn blank(&self) -> Frame {
        Frame::new(self.bounds.width, self.bounds.height)
    }

    /// Draws display `index`'s whole image into its place, resampled when
    /// its size differs from the place's.
    pub fn draw(&mut self, frame: &mut Frame, index: usize, image: &Frame) {
        let Some(place) = self.place(index) else {
            return;
        };
        let source = if (image.width, image.height) == (place.width, place.height) {
            image
        } else {
            if (self.scratch.width, self.scratch.height) != (place.width, place.height) {
                self.scratch = Frame::new(place.width, place.height);
            }
            scale::downscale(image, &mut self.scratch);
            &self.scratch
        };
        copy_into(frame, place, source);
    }

    /// What changed in display `index` (whose image is `image_size`),
    /// moved to its place in the frame.
    pub fn damage(&self, index: usize, image_size: (u32, u32), damage: &Damage) -> Damage {
        let Some(place) = self.place(index) else {
            return Damage::None;
        };
        let rects = match damage {
            Damage::None => return Damage::None,
            Damage::Unknown => vec![place],
            Damage::Rects(rects) if image_size == (place.width, place.height) => rects
                .iter()
                .filter_map(|r| r.offset(-place.x, -place.y).intersect(&place))
                .collect(),
            Damage::Rects(_) => {
                let Damage::Rects(rects) =
                    scale::scale_damage(damage, image_size, (place.width, place.height))
                else {
                    return Damage::Rects(vec![place]);
                };
                rects
                    .iter()
                    .filter_map(|r| r.offset(-place.x, -place.y).intersect(&place))
                    .collect()
            }
        };
        Damage::Rects(rects)
    }

    /// Blacks out every pixel inside `area` (frame pixels) that no display
    /// covers: what a capture of the whole desktop (the X root window, the
    /// Windows virtual screen) shows between monitors of different sizes.
    pub fn blank_gaps(&self, frame: &mut Frame, area: Rect) {
        let Some(area) = area.intersect(&Rect::new(0, 0, frame.width, frame.height)) else {
            return;
        };
        let (left, right) = (i64::from(area.x), area.right());
        for y in area.y..area.y + area.height as i32 {
            let mut covered: Vec<(i64, i64)> = self
                .places
                .iter()
                .filter(|p| y >= p.y && i64::from(y) < p.bottom())
                .map(|p| (i64::from(p.x).max(left), p.right().min(right)))
                .filter(|(start, end)| start < end)
                .collect();
            covered.sort_unstable();
            let row = frame.row_mut(y as u32);
            let mut x = left;
            for (start, end) in covered {
                if start > x {
                    zero(row, x, start);
                }
                x = x.max(end);
            }
            if x < right {
                zero(row, x, right);
            }
        }
    }
}

fn zero(row: &mut [u8], from: i64, to: i64) {
    row[from as usize * BYTES_PER_PIXEL..to as usize * BYTES_PER_PIXEL].fill(0);
}

/// Copies `source` (the place's size) into `frame` at `place`.
fn copy_into(frame: &mut Frame, place: Rect, source: &Frame) {
    let Some(visible) = place.intersect(&Rect::new(0, 0, frame.width, frame.height)) else {
        return;
    };
    let skip_x = (visible.x - place.x) as usize;
    let skip_y = (visible.y - place.y) as u32;
    let bytes = visible.width as usize * BYTES_PER_PIXEL;
    let start = visible.x as usize * BYTES_PER_PIXEL;
    for row in 0..visible.height {
        let from = &source.row(skip_y + row)[skip_x * BYTES_PER_PIXEL..][..bytes];
        frame.row_mut(visible.y as u32 + row)[start..start + bytes].copy_from_slice(from);
    }
}

#[cfg(test)]
#[path = "combined_tests.rs"]
mod tests;
