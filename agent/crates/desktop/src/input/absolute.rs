//! Absolute pointer positions (SPEC-DESKTOP-ALL-SCREENS, Pointer): from a
//! point on BMuster's desktop to the 0..=65535 value an absolute device
//! reports, so a click lands on the pixel the viewer pointed at, on the
//! right monitor, right up to the edge between two of them.
//!
//! - **uinput under mutter** ([`PointerMap`]): libinput scales an absolute
//!   pointer to the whole stage, `value * stage / 65536` in mutter's
//!   logical pixels, and mutter picks the logical monitor that holds the
//!   result. The stage is mutter's layout, which BMuster's desktop scales
//!   by the smallest monitor scale (`capture::kms::layout`), so each point
//!   is mapped through its own monitor's rectangle on both sides.
//! - **Windows** (`SendInput` with `MOUSEEVENTF_VIRTUALDESK`) spans the
//!   virtual screen in the same pixels as the desktop: [`axis`] aims a
//!   quarter of a pixel in, which lands on the same pixel whether Windows
//!   rounds or truncates.

use crate::capture::Rect;
use std::sync::{Arc, Mutex};

/// Steps across the whole axis: values run 0..=65535.
pub const STEPS: f64 = 65536.0;

/// The map the capturer keeps up to date and the uinput pointer reads.
pub type SharedPointerMap = Arc<Mutex<PointerMap>>;

/// The value whose `value * size / 65536` falls at `position` (or within
/// `size / 65536` below it), for a position `0..size` along the axis.
pub fn axis(position: f64, size: f64) -> i32 {
    if size <= 0.0 {
        return 0;
    }
    (position * STEPS / size).floor().clamp(0.0, STEPS - 1.0) as i32
}

/// One monitor: its place on BMuster's desktop and on the device's stage.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Mapped {
    pub desktop: Rect,
    pub stage: Rect,
}

/// Where each monitor is on the desktop and on the stage an absolute
/// device spans.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PointerMap {
    monitors: Vec<Mapped>,
    /// The stage's bounding box: what 0..=65535 spans.
    stage: Rect,
}

impl PointerMap {
    /// Monitors laid out the same on the desktop and the stage (the
    /// side-by-side fallback, or one display).
    pub fn identity(desktop: &[Rect]) -> PointerMap {
        PointerMap::new(
            desktop
                .iter()
                .map(|&rect| Mapped {
                    desktop: rect,
                    stage: rect,
                })
                .collect(),
        )
    }

    pub fn new(monitors: Vec<Mapped>) -> PointerMap {
        let stage = bounding(monitors.iter().map(|m| m.stage));
        PointerMap { monitors, stage }
    }

    /// The device values for desktop pixel `(x, y)`. A point between
    /// monitors goes to the nearest one, at its nearest pixel.
    pub fn to_absolute(&self, x: i32, y: i32) -> (i32, i32) {
        let Some(monitor) = self
            .monitors
            .iter()
            .min_by_key(|m| distance(&m.desktop, x, y))
        else {
            return (0, 0);
        };
        let along = |value: i32, start: i32, size: u32, stage_start: i32, stage_size: u32| {
            let last = i64::from(size.max(1)) - 1;
            let offset = (i64::from(value) - i64::from(start)).clamp(0, last) as f64;
            // The middle of the desktop pixel, on the stage.
            f64::from(stage_start) + (offset + 0.5) * f64::from(stage_size) / f64::from(size.max(1))
        };
        let sx = along(
            x,
            monitor.desktop.x,
            monitor.desktop.width,
            monitor.stage.x,
            monitor.stage.width,
        );
        let sy = along(
            y,
            monitor.desktop.y,
            monitor.desktop.height,
            monitor.stage.y,
            monitor.stage.height,
        );
        (
            axis(sx - f64::from(self.stage.x), f64::from(self.stage.width)),
            axis(sy - f64::from(self.stage.y), f64::from(self.stage.height)),
        )
    }
}

/// How far `(x, y)` is outside `rect` (0 inside), squared.
fn distance(rect: &Rect, x: i32, y: i32) -> i64 {
    let gap = |value: i32, start: i32, end: i64| {
        let value = i64::from(value);
        if value < i64::from(start) {
            i64::from(start) - value
        } else if value >= end {
            value - end + 1
        } else {
            0
        }
    };
    let dx = gap(x, rect.x, rect.right());
    let dy = gap(y, rect.y, rect.bottom());
    dx * dx + dy * dy
}

fn bounding(rects: impl Iterator<Item = Rect>) -> Rect {
    let mut found: Option<(i64, i64, i64, i64)> = None;
    for r in rects {
        let (left, top, right, bottom) = (i64::from(r.x), i64::from(r.y), r.right(), r.bottom());
        found = Some(match found {
            None => (left, top, right, bottom),
            Some((l, t, rr, b)) => (l.min(left), t.min(top), rr.max(right), b.max(bottom)),
        });
    }
    match found {
        Some((left, top, right, bottom)) => Rect::new(
            left as i32,
            top as i32,
            (right - left).max(1) as u32,
            (bottom - top).max(1) as u32,
        ),
        None => Rect::new(0, 0, 1, 1),
    }
}

#[cfg(test)]
#[path = "absolute_tests.rs"]
mod tests;
