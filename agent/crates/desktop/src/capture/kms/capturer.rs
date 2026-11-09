//! The session's [`Capturer`] over a [`KmsSource`] (SPEC-CONSOLE-CAPTURE,
//! Capture 5–6): polls at the session's frame rate, lets the tile diff find
//! what changed (KMS has no damage), and refreshes the display list when a
//! CRTC, mode or size changes. A new framebuffer id alone is not a change:
//! compositors flip between two or three every frame.

use super::{KmsDisplay, KmsSource, SCREEN_OFF};
use crate::capture::{
    CaptureError, CaptureResult, Capturer, CursorImage, CursorState, Damage, DesktopState,
    DisplayInfo, Frame, Rect,
};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// A source shared by the screen watch (which asks for the display list
/// once a second) and the session's capturer.
pub type SharedSource = Arc<Mutex<Box<dyn KmsSource + Send>>>;

/// How often the display list is read while capturing.
pub const LAYOUT_EVERY: Duration = Duration::from_millis(500);

/// The bounding box of every display, which the uinput pointer spans.
pub type SharedBounds = Arc<Mutex<Rect>>;

pub fn bounds_of(displays: &[DisplayInfo]) -> Rect {
    let Some(first) = displays.first() else {
        return Rect::new(0, 0, 1, 1);
    };
    let (mut left, mut top) = (first.x, first.y);
    let (mut right, mut bottom) = (
        i64::from(first.x) + i64::from(first.width),
        i64::from(first.y) + i64::from(first.height),
    );
    for d in displays {
        left = left.min(d.x);
        top = top.min(d.y);
        right = right.max(i64::from(d.x) + i64::from(d.width));
        bottom = bottom.max(i64::from(d.y) + i64::from(d.height));
    }
    Rect::new(
        left,
        top,
        (right - i64::from(left)).max(1) as u32,
        (bottom - i64::from(top)).max(1) as u32,
    )
}

pub struct KmsCapturer {
    source: SharedSource,
    bounds: SharedBounds,
    kms: Vec<KmsDisplay>,
    displays: Vec<DisplayInfo>,
    current: usize,
    frame: Frame,
    /// The next capture must return the whole image.
    full: bool,
    next_layout: Instant,
}

fn lock(source: &SharedSource) -> std::sync::MutexGuard<'_, Box<dyn KmsSource + Send>> {
    source
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl KmsCapturer {
    /// Reads the display list; fails with [`SCREEN_OFF`] when there is none.
    pub fn new(source: SharedSource, bounds: SharedBounds) -> CaptureResult<KmsCapturer> {
        let kms = lock(&source).displays()?;
        if kms.is_empty() {
            return Err(CaptureError::new(SCREEN_OFF));
        }
        let mut capturer = KmsCapturer {
            source,
            bounds,
            kms: Vec::new(),
            displays: Vec::new(),
            current: 0,
            frame: Frame::new(0, 0),
            full: true,
            next_layout: Instant::now() + LAYOUT_EVERY,
        };
        capturer.set_layout(kms);
        Ok(capturer)
    }

    fn set_layout(&mut self, kms: Vec<KmsDisplay>) {
        let current_id = self.kms.get(self.current).map(|d| d.id.clone());
        self.displays = kms.iter().map(KmsDisplay::info).collect();
        self.current = current_id
            .and_then(|id| kms.iter().position(|d| d.id == id))
            .unwrap_or(0);
        self.kms = kms;
        *self.bounds.lock().unwrap_or_else(|p| p.into_inner()) = bounds_of(&self.displays);
        self.full = true;
    }

    fn current_id(&self) -> CaptureResult<String> {
        self.kms
            .get(self.current)
            .map(|d| d.id.clone())
            .ok_or_else(|| CaptureError::new(SCREEN_OFF))
    }
}

impl Capturer for KmsCapturer {
    fn displays(&self) -> &[DisplayInfo] {
        &self.displays
    }

    fn current(&self) -> usize {
        self.current
    }

    fn select(&mut self, index: usize) -> CaptureResult<()> {
        if index >= self.kms.len() {
            return Err(CaptureError::new(format!("There is no display {index}")));
        }
        self.current = index;
        self.full = true;
        Ok(())
    }

    fn poll_layout(&mut self) -> CaptureResult<bool> {
        let now = Instant::now();
        if now < self.next_layout {
            return Ok(false);
        }
        self.next_layout = now + LAYOUT_EVERY;
        let kms = lock(&self.source).displays()?;
        if kms.is_empty() {
            // The session looks again and waits with "The screen is off".
            return Err(CaptureError::new(SCREEN_OFF));
        }
        if kms == self.kms {
            return Ok(false);
        }
        log::info!(
            "The KMS displays changed: {}",
            kms.iter()
                .map(|d| format!("{} {}x{}", d.id, d.width, d.height))
                .collect::<Vec<_>>()
                .join(", ")
        );
        self.set_layout(kms);
        Ok(true)
    }

    fn capture(&mut self, full: bool) -> CaptureResult<Damage> {
        let id = self.current_id()?;
        let whole = full || self.full;
        match lock(&self.source).capture(&id, whole)? {
            Some(frame) => {
                self.frame = frame;
                self.full = false;
                Ok(Damage::Unknown)
            }
            None => Ok(Damage::None),
        }
    }

    fn frame(&self) -> &Frame {
        &self.frame
    }

    fn cursor(&mut self) -> CaptureResult<CursorState> {
        let id = self.current_id()?;
        let display = self.displays[self.current].clone();
        let cursor = lock(&self.source).cursor(&id)?;
        Ok(CursorState {
            id: cursor.shape,
            x: display.x + cursor.x,
            y: display.y + cursor.y,
            visible: cursor.visible,
        })
    }

    fn cursor_image(&mut self, id: u32) -> CaptureResult<Option<CursorImage>> {
        lock(&self.source).cursor_image(id)
    }

    fn state(&self) -> DesktopState {
        DesktopState::Desktop { user: None }
    }
}

/// A [`KmsSource`] the tests drive: displays and frames they set.
#[cfg(test)]
pub mod fake {
    use super::super::{KmsCursor, KmsDisplay, KmsSource};
    use crate::capture::{CaptureError, CaptureResult, CursorImage, Frame};
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    pub struct Screens {
        pub displays: Vec<KmsDisplay>,
        /// Colour per display id; a frame is the display's size in it.
        pub colours: Vec<(String, [u8; 4])>,
        pub broken: Option<String>,
        pub captures: u32,
    }

    #[derive(Clone, Default)]
    pub struct FakeKms(pub Arc<Mutex<Screens>>);

    pub fn display(id: &str, x: i32, width: u32, height: u32) -> KmsDisplay {
        KmsDisplay {
            id: id.into(),
            name: id.into(),
            card: "card0".into(),
            crtc_id: 1,
            x,
            y: 0,
            width,
            height,
            fb_x: 0,
            fb_y: 0,
            primary: x == 0,
        }
    }

    impl KmsSource for FakeKms {
        fn displays(&mut self) -> CaptureResult<Vec<KmsDisplay>> {
            let screens = self.0.lock().unwrap();
            if let Some(reason) = &screens.broken {
                return Err(CaptureError::new(reason));
            }
            Ok(screens.displays.clone())
        }
        fn capture(&mut self, id: &str, _full: bool) -> CaptureResult<Option<Frame>> {
            let mut screens = self.0.lock().unwrap();
            screens.captures += 1;
            let display = screens
                .displays
                .iter()
                .find(|d| d.id == id)
                .cloned()
                .ok_or_else(|| CaptureError::new("no such display"))?;
            let colour = screens
                .colours
                .iter()
                .find(|(d, _)| d == id)
                .map_or([0, 0, 0, 0], |(_, c)| *c);
            let mut frame = Frame::new(display.width, display.height);
            frame.fill(
                crate::capture::Rect::new(0, 0, display.width, display.height),
                colour,
            );
            Ok(Some(frame))
        }
        fn cursor(&mut self, _id: &str) -> CaptureResult<KmsCursor> {
            Ok(KmsCursor::HIDDEN)
        }
        fn cursor_image(&mut self, _shape: u32) -> CaptureResult<Option<CursorImage>> {
            Ok(None)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fake::{display, FakeKms};
    use super::*;

    #[test]
    fn kms_capturer_keeps_its_display_and_spans_the_bounds() {
        let fake = FakeKms::default();
        fake.0.lock().unwrap().displays =
            vec![display("a", 0, 100, 50), display("b", 100, 200, 80)];
        let source: SharedSource = Arc::new(Mutex::new(Box::new(fake.clone())));
        let bounds: SharedBounds = Arc::new(Mutex::new(Rect::new(0, 0, 1, 1)));
        let mut capturer = KmsCapturer::new(source, bounds.clone()).unwrap();
        assert_eq!(*bounds.lock().unwrap(), Rect::new(0, 0, 300, 80));
        capturer.select(1).unwrap();
        assert_eq!(capturer.capture(false).unwrap(), Damage::Unknown);
        assert_eq!(capturer.frame().width, 200);
        // Display a goes away; b stays current, at a new position.
        fake.0.lock().unwrap().displays = vec![display("b", 0, 200, 80)];
        capturer.next_layout = Instant::now();
        assert!(capturer.poll_layout().unwrap());
        assert_eq!((capturer.current(), capturer.displays()[0].x), (0, 0));
        assert_eq!(*bounds.lock().unwrap(), Rect::new(0, 0, 200, 80));
        // Everything off: an error, so the session looks again.
        fake.0.lock().unwrap().displays.clear();
        capturer.next_layout = Instant::now();
        assert_eq!(capturer.poll_layout().unwrap_err().0, SCREEN_OFF);
    }
}
