//! The session's [`Capturer`] over a [`KmsSource`] (SPEC-CONSOLE-CAPTURE,
//! Capture 5–6): polls at the session's frame rate, lets the tile diff find
//! what changed (KMS has no damage), and refreshes the display list when a
//! CRTC, mode or size changes. A new framebuffer id alone is not a change:
//! compositors flip between two or three every frame.
//!
//! Displays are laid out by [`layout::arrange`] (SPEC-DESKTOP-ALL-SCREENS):
//! the compositor's arrangement on a GNOME or KDE Plasma desktop, else side by
//! side. [`View::All`] draws every display into one frame at its place.

use super::compositor::LayoutReader;
use super::layout::{self, Arrangement, LayoutSource};
use super::{KmsDisplay, KmsSource, SCREEN_OFF};
use crate::capture::combined::Combined;
use crate::capture::{
    keep_view, primary_view, CaptureError, CaptureResult, Capturer, CursorImage, CursorState,
    Damage, DesktopState, DisplayInfo, Frame, View,
};
use crate::input::absolute::{PointerMap, SharedPointerMap};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// A source shared by the screen watch (which asks for the display list
/// once a second) and the session's capturer.
pub type SharedSource = Arc<Mutex<Box<dyn KmsSource + Send>>>;

/// How often the display list is read while capturing.
pub const LAYOUT_EVERY: Duration = Duration::from_millis(500);
/// How often the compositor is asked again, for a rearrangement KMS cannot
/// see.
pub const COMPOSITOR_EVERY: Duration = Duration::from_secs(5);

pub struct KmsCapturer {
    source: SharedSource,
    pointer: SharedPointerMap,
    reader: Box<dyn LayoutReader>,
    kms: Vec<KmsDisplay>,
    arrangement: Arrangement,
    view: View,
    /// Set while the view is [`View::All`].
    combined: Option<Combined>,
    frame: Frame,
    /// The next capture must return the whole image.
    full: bool,
    next_layout: Instant,
    next_compositor: Instant,
}

fn lock(source: &SharedSource) -> std::sync::MutexGuard<'_, Box<dyn KmsSource + Send>> {
    source
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl KmsCapturer {
    /// Reads the display list and lays it out; fails with [`SCREEN_OFF`]
    /// when there is none. `pointer` is kept up to date for the uinput
    /// pointer; `reader` says where the compositor puts the displays.
    pub fn new(
        source: SharedSource,
        pointer: SharedPointerMap,
        reader: Box<dyn LayoutReader>,
    ) -> CaptureResult<KmsCapturer> {
        let kms = lock(&source).displays()?;
        if kms.is_empty() {
            return Err(CaptureError::new(SCREEN_OFF));
        }
        let now = Instant::now();
        let mut capturer = KmsCapturer {
            source,
            pointer,
            reader,
            kms: Vec::new(),
            arrangement: layout::side_by_side(&[], String::new()),
            view: View::Display(0),
            combined: None,
            frame: Frame::new(0, 0),
            full: true,
            next_layout: now + LAYOUT_EVERY,
            next_compositor: now + COMPOSITOR_EVERY,
        };
        capturer.set_layout(kms);
        Ok(capturer)
    }

    /// Lays `kms` out; true when the displays or their layout changed.
    fn set_layout(&mut self, kms: Vec<KmsDisplay>) -> bool {
        let arrangement = if kms.len() < 2 {
            // One display maps the same whichever way it is laid out.
            layout::side_by_side(&kms, "one display".into())
        } else {
            let state = self.reader.read();
            layout::arrange(&kms, state.as_ref().map_err(String::clone))
        };
        let changed = arrangement != self.arrangement || kms != self.kms;
        if !changed {
            return false;
        }
        if arrangement.source != self.arrangement.source
            || arrangement.displays != self.arrangement.displays
        {
            log_arrangement(&arrangement);
        }
        *self.pointer.lock().unwrap_or_else(|p| p.into_inner()) = arrangement.pointer.clone();
        self.view = if self.arrangement.displays.is_empty() {
            primary_view(&arrangement.displays)
        } else {
            keep_view(&self.arrangement.displays, self.view, &arrangement.displays)
        };
        self.arrangement = arrangement;
        self.kms = kms;
        self.combined = match self.view {
            View::All => Combined::new(&self.arrangement.displays),
            View::Display(_) => None,
        };
        if let Some(combined) = &self.combined {
            self.frame = combined.blank();
        }
        self.full = true;
        true
    }

    fn kms_of(&self, index: usize) -> CaptureResult<&KmsDisplay> {
        self.kms
            .get(index)
            .ok_or_else(|| CaptureError::new(SCREEN_OFF))
    }

    /// A cursor on display `index`, in desktop units.
    fn cursor_on(&self, index: usize) -> CaptureResult<Option<CursorState>> {
        let kms = self.kms_of(index)?;
        let Some(display) = self.arrangement.displays.get(index) else {
            return Ok(None);
        };
        let cursor = lock(&self.source).cursor(&kms.id)?;
        // The cursor plane is in mode pixels; the desktop can be smaller.
        let along = |value: i32, size: u32, mode: u32| {
            (i64::from(value) * i64::from(size) / i64::from(mode.max(1))) as i32
        };
        Ok(Some(CursorState {
            id: cursor.shape,
            x: display.x + along(cursor.x, display.width, kms.width),
            y: display.y + along(cursor.y, display.height, kms.height),
            visible: cursor.visible,
        }))
    }
}

/// Which layout is in use, and where every display is (SPEC-DESKTOP-ALL-SCREENS 6).
fn log_arrangement(arrangement: &Arrangement) {
    let rects = arrangement
        .displays
        .iter()
        .map(|d| format!("{} {}x{}+{}+{}", d.name, d.width, d.height, d.x, d.y))
        .collect::<Vec<_>>()
        .join(", ");
    match &arrangement.source {
        LayoutSource::Compositor(compositor) => {
            log::info!("Display layout from {}: {rects}", compositor.name())
        }
        LayoutSource::SideBySide { reason } => {
            log::info!("Display layout side by side ({reason}): {rects}")
        }
    }
}

impl Capturer for KmsCapturer {
    fn displays(&self) -> &[DisplayInfo] {
        &self.arrangement.displays
    }

    fn view(&self) -> View {
        self.view
    }

    fn can_show_all(&self) -> bool {
        Combined::possible(&self.arrangement.displays)
    }

    fn select(&mut self, view: View) -> CaptureResult<()> {
        match view {
            View::Display(index) if index >= self.kms.len() => {
                return Err(CaptureError::new(format!("There is no display {index}")));
            }
            View::Display(_) => self.combined = None,
            View::All => {
                let combined = Combined::new(&self.arrangement.displays).ok_or_else(|| {
                    CaptureError::new("These displays cannot be shown all at once")
                })?;
                self.frame = combined.blank();
                self.combined = Some(combined);
            }
        }
        self.view = view;
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
        let ask_compositor = now >= self.next_compositor;
        if kms == self.kms && !ask_compositor {
            return Ok(false);
        }
        if kms != self.kms {
            log::info!(
                "The KMS displays changed: {}",
                kms.iter()
                    .map(|d| format!("{} {}x{}", d.id, d.width, d.height))
                    .collect::<Vec<_>>()
                    .join(", ")
            );
        }
        self.next_compositor = now + COMPOSITOR_EVERY;
        Ok(self.set_layout(kms))
    }

    fn capture(&mut self, full: bool) -> CaptureResult<Damage> {
        let whole = full || self.full;
        if let View::Display(index) = self.view {
            let id = self.kms_of(index)?.id.clone();
            return match lock(&self.source).capture(&id, whole)? {
                Some(frame) => {
                    self.frame = frame;
                    self.full = false;
                    Ok(Damage::Unknown)
                }
                None => Ok(Damage::None),
            };
        }
        let Some(combined) = self.combined.as_mut() else {
            return Err(CaptureError::new(
                "These displays cannot be shown all at once",
            ));
        };
        let mut changed = Vec::new();
        for (index, kms) in self.kms.iter().enumerate() {
            let image = lock(&self.source).capture(&kms.id, whole)?;
            if let Some(image) = image {
                combined.draw(&mut self.frame, index, &image);
                if let Damage::Rects(rects) =
                    combined.damage(index, (image.width, image.height), &Damage::Unknown)
                {
                    changed.extend(rects);
                }
            }
        }
        self.full = false;
        Ok(if changed.is_empty() {
            Damage::None
        } else {
            Damage::Rects(changed)
        })
    }

    fn frame(&self) -> &Frame {
        &self.frame
    }

    fn cursor(&mut self) -> CaptureResult<CursorState> {
        match self.view {
            View::Display(index) => self
                .cursor_on(index)?
                .ok_or_else(|| CaptureError::new(SCREEN_OFF)),
            // The pointer is on one display; its cursor plane is the lit one.
            View::All => {
                let mut hidden = None;
                for index in 0..self.kms.len() {
                    match self.cursor_on(index)? {
                        Some(cursor) if cursor.visible => return Ok(cursor),
                        Some(cursor) => {
                            hidden.get_or_insert(cursor);
                        }
                        None => {}
                    }
                }
                hidden.ok_or_else(|| CaptureError::new(SCREEN_OFF))
            }
        }
    }

    fn cursor_image(&mut self, id: u32) -> CaptureResult<Option<CursorImage>> {
        lock(&self.source).cursor_image(id)
    }

    fn state(&self) -> DesktopState {
        DesktopState::Desktop { user: None }
    }

    fn backend(&self) -> &'static str {
        "kms"
    }
}

/// The map a uinput pointer starts with, before a capturer lays out.
pub fn unset_pointer() -> SharedPointerMap {
    Arc::new(Mutex::new(PointerMap::identity(&[])))
}

/// A [`KmsSource`] the tests drive: displays, frames and cursors they set.
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
        /// The cursor plane per display id; hidden when not listed.
        pub cursors: Vec<(String, KmsCursor)>,
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
        fn cursor(&mut self, id: &str) -> CaptureResult<KmsCursor> {
            let screens = self.0.lock().unwrap();
            Ok(screens
                .cursors
                .iter()
                .find(|(d, _)| d == id)
                .map_or(KmsCursor::HIDDEN, |(_, c)| *c))
        }
        fn cursor_image(&mut self, _shape: u32) -> CaptureResult<Option<CursorImage>> {
            Ok(None)
        }
    }
}

#[cfg(test)]
#[path = "capturer_tests.rs"]
mod tests;
