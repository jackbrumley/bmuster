//! When the notice bar is full size and when it folds to a pill
//! (SPEC-DESKTOP 8.1, notice version 2). Platform-free, with the clock
//! passed in, so the platform bars only draw the two sizes.
//!
//! The bar opens full size ("Kim is connected (BMuster) · Disconnect") when
//! it first comes up and whenever a new viewer joins, and folds after
//! [`OPEN_FOR`] to a small pill at the same top-centre edge. The pointer
//! over it (or a press on it, for touch screens) opens it again; it folds
//! [`LINGER`] after the pointer leaves. It never goes away while anyone is
//! connected: closing it is the board's job, not this one's.

use std::time::{Duration, Instant};

/// How long the bar stays full size after it comes up, a viewer joins or
/// it is pressed.
pub const OPEN_FOR: Duration = Duration::from_secs(6);
/// How long the bar stays full size after the pointer leaves it.
pub const LINGER: Duration = Duration::from_secs(3);

/// The two sizes the platform bars draw.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Size {
    /// The names and the Disconnect button.
    Full,
    /// A small marker and "BMuster · 1 connected", no button.
    Pill,
}

/// The folding state of one bar.
#[derive(Debug, Clone)]
pub struct Fold {
    names: Vec<String>,
    pointer_inside: bool,
    full_until: Instant,
}

impl Fold {
    /// A bar that just came up showing `names`: full size.
    pub fn new(names: &[String], now: Instant) -> Self {
        Self {
            names: names.to_vec(),
            pointer_inside: false,
            full_until: now + OPEN_FOR,
        }
    }

    /// The board sent the names again: a new viewer opens the bar full
    /// size; someone leaving does not.
    pub fn names(&mut self, names: &[String], now: Instant) {
        if joined(&self.names, names) {
            self.open_until(now + OPEN_FOR);
        }
        self.names = names.to_vec();
    }

    /// The pointer is over the bar (`true`) or not. Leaving starts the
    /// linger.
    pub fn pointer(&mut self, inside: bool, now: Instant) {
        if self.pointer_inside && !inside {
            self.open_until(now + LINGER);
        }
        self.pointer_inside = inside;
    }

    /// A press on the pill (a touch screen has no hover).
    pub fn pressed(&mut self, now: Instant) {
        self.open_until(now + OPEN_FOR);
    }

    /// The size to draw at `now`.
    pub fn size(&self, now: Instant) -> Size {
        if self.pointer_inside || now < self.full_until {
            Size::Full
        } else {
            Size::Pill
        }
    }

    fn open_until(&mut self, until: Instant) {
        self.full_until = self.full_until.max(until);
    }
}

/// True when `after` has someone `before` did not (counting a name twice
/// when two viewers share it).
fn joined(before: &[String], after: &[String]) -> bool {
    after.iter().any(|name| {
        let was = before.iter().filter(|n| *n == name).count();
        let now = after.iter().filter(|n| *n == name).count();
        now > was
    })
}

/// The pill's label: "BMuster · 1 connected".
pub fn pill_text(count: usize) -> String {
    format!("BMuster \u{b7} {count} connected")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|n| n.to_string()).collect()
    }

    #[test]
    fn notice_fold_opens_full_then_folds_after_six_seconds() {
        let start = Instant::now();
        let fold = Fold::new(&names(&["Kim"]), start);
        assert_eq!(fold.size(start), Size::Full);
        assert_eq!(fold.size(start + Duration::from_millis(5_999)), Size::Full);
        assert_eq!(fold.size(start + OPEN_FOR), Size::Pill);
        assert_eq!(fold.size(start + Duration::from_secs(600)), Size::Pill);
    }

    #[test]
    fn notice_fold_opens_again_when_a_viewer_joins_but_not_when_one_leaves() {
        let start = Instant::now();
        let mut fold = Fold::new(&names(&["Kim"]), start);
        let later = start + Duration::from_secs(20);
        assert_eq!(fold.size(later), Size::Pill);
        fold.names(&names(&["Kim", "Lee"]), later);
        assert_eq!(fold.size(later), Size::Full, "Lee joined");
        assert_eq!(fold.size(later + OPEN_FOR), Size::Pill);
        let leaving = later + Duration::from_secs(30);
        fold.names(&names(&["Lee"]), leaving);
        assert_eq!(fold.size(leaving), Size::Pill, "Kim left: stays folded");
        // A second session for the same person is a new viewer.
        fold.names(&names(&["Lee", "Lee"]), leaving);
        assert_eq!(fold.size(leaving), Size::Full);
    }

    #[test]
    fn notice_fold_opens_on_hover_and_folds_three_seconds_after_the_pointer_leaves() {
        let start = Instant::now();
        let mut fold = Fold::new(&names(&["Kim"]), start);
        let hover = start + Duration::from_secs(10);
        assert_eq!(fold.size(hover), Size::Pill);
        fold.pointer(true, hover);
        assert_eq!(fold.size(hover), Size::Full);
        // However long the pointer stays.
        assert_eq!(fold.size(hover + Duration::from_secs(60)), Size::Full);
        let left = hover + Duration::from_secs(60);
        fold.pointer(false, left);
        assert_eq!(fold.size(left + Duration::from_millis(2_999)), Size::Full);
        assert_eq!(fold.size(left + LINGER), Size::Pill);
        // Reports of "still outside" do not restart the linger.
        fold.pointer(false, left + Duration::from_secs(2));
        assert_eq!(fold.size(left + LINGER), Size::Pill);
    }

    #[test]
    fn notice_fold_opens_when_the_pill_is_pressed() {
        let start = Instant::now();
        let mut fold = Fold::new(&names(&["Kim"]), start);
        let pressed = start + Duration::from_secs(30);
        fold.pressed(pressed);
        assert_eq!(fold.size(pressed), Size::Full);
        assert_eq!(fold.size(pressed + OPEN_FOR), Size::Pill);
    }

    #[test]
    fn notice_fold_a_short_linger_never_cuts_a_longer_opening() {
        let start = Instant::now();
        let mut fold = Fold::new(&names(&["Kim"]), start);
        fold.pointer(true, start + Duration::from_secs(1));
        fold.pointer(false, start + Duration::from_secs(2));
        // The opening (6 s) outlasts the linger (2 + 3 s).
        assert_eq!(fold.size(start + Duration::from_millis(5_500)), Size::Full);
        assert_eq!(fold.size(start + OPEN_FOR), Size::Pill);
    }

    #[test]
    fn notice_pill_text_counts_viewers() {
        assert_eq!(pill_text(1), "BMuster \u{b7} 1 connected");
        assert_eq!(pill_text(3), "BMuster \u{b7} 3 connected");
    }
}
