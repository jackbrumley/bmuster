//! Screen capture: the platform-neutral types and the [`Capturer`] trait.
//!
//! Pixels are always 32-bit BGRX (blue, green, red, then a byte that is
//! ignored), top row first. That is what X11 ZPixmap at depth 24/32, DXGI and
//! GDI DIB sections all give, so no platform converts pixels.

#[cfg(target_os = "linux")]
pub mod x11;
#[cfg(target_os = "linux")]
pub mod x11_session;

#[cfg(windows)]
pub mod dxgi;
#[cfg(windows)]
pub mod gdi;
#[cfg(windows)]
pub mod windows;

use serde::Serialize;

/// Bytes per pixel in a [`Frame`].
pub const BYTES_PER_PIXEL: usize = 4;

/// A rectangle in pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl Rect {
    pub fn new(x: i32, y: i32, width: u32, height: u32) -> Self {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    fn right(&self) -> i64 {
        i64::from(self.x) + i64::from(self.width)
    }

    fn bottom(&self) -> i64 {
        i64::from(self.y) + i64::from(self.height)
    }

    /// The overlap of two rectangles, if any.
    pub fn intersect(&self, other: &Rect) -> Option<Rect> {
        let left = self.x.max(other.x);
        let top = self.y.max(other.y);
        let right = self.right().min(other.right());
        let bottom = self.bottom().min(other.bottom());
        if right <= i64::from(left) || bottom <= i64::from(top) {
            return None;
        }
        Some(Rect {
            x: left,
            y: top,
            width: (right - i64::from(left)) as u32,
            height: (bottom - i64::from(top)) as u32,
        })
    }

    /// The same rectangle relative to `origin`.
    pub fn offset(&self, dx: i32, dy: i32) -> Rect {
        Rect {
            x: self.x - dx,
            y: self.y - dy,
            ..*self
        }
    }
}

/// One captured screen image, BGRX.
#[derive(Clone, PartialEq, Eq)]
pub struct Frame {
    pub width: u32,
    pub height: u32,
    /// Bytes per row; at least `width * 4`.
    pub stride: usize,
    pub data: Vec<u8>,
}

impl std::fmt::Debug for Frame {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Frame({}x{})", self.width, self.height)
    }
}

impl Frame {
    /// A black frame.
    pub fn new(width: u32, height: u32) -> Self {
        let stride = width as usize * BYTES_PER_PIXEL;
        Frame {
            width,
            height,
            stride,
            data: vec![0; stride * height as usize],
        }
    }

    /// The bytes of one row, `width * 4` long.
    pub fn row(&self, y: u32) -> &[u8] {
        let start = y as usize * self.stride;
        &self.data[start..start + self.width as usize * BYTES_PER_PIXEL]
    }

    pub fn row_mut(&mut self, y: u32) -> &mut [u8] {
        let start = y as usize * self.stride;
        let len = self.width as usize * BYTES_PER_PIXEL;
        &mut self.data[start..start + len]
    }

    /// Fills a rectangle with one colour (tests and benchmarks).
    pub fn fill(&mut self, rect: Rect, bgrx: [u8; 4]) {
        let Some(rect) = rect.intersect(&Rect::new(0, 0, self.width, self.height)) else {
            return;
        };
        for y in rect.y as u32..rect.y as u32 + rect.height {
            let row = self.row_mut(y);
            for x in rect.x as usize..rect.x as usize + rect.width as usize {
                row[x * 4..x * 4 + 4].copy_from_slice(&bgrx);
            }
        }
    }
}

/// One display (monitor) as the `displays` message lists it.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DisplayInfo {
    /// Stable name: the RandR monitor or the Windows device name.
    pub id: String,
    pub name: String,
    /// Position on the virtual desktop.
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    /// Desktop scale factor (1 when the platform has none per display).
    pub scale: f64,
    pub primary: bool,
}

impl DisplayInfo {
    pub fn rect(&self) -> Rect {
        Rect::new(self.x, self.y, self.width, self.height)
    }
}

/// What changed since the last capture.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Damage {
    /// Nothing changed; the frame was not refreshed.
    None,
    /// These areas changed (relative to the display); the frame was refreshed.
    Rects(Vec<Rect>),
    /// The platform cannot say what changed; compare the whole frame.
    Unknown,
}

/// A cursor image, RGBA with straight (not premultiplied) alpha.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CursorImage {
    pub width: u32,
    pub height: u32,
    pub hotspot_x: u32,
    pub hotspot_y: u32,
    pub rgba: Vec<u8>,
}

/// Where the pointer is and which shape it shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CursorState {
    /// Changes whenever the shape changes.
    pub id: u32,
    /// Position on the virtual desktop.
    pub x: i32,
    pub y: i32,
    pub visible: bool,
}

/// Where the session is: the sign-in screen or someone's desktop.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopState {
    pub desktop: DesktopKind,
    pub locked: bool,
    pub signed_in_user: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DesktopKind {
    Default,
    Winlogon,
    Secure,
    Greeter,
}

/// A failure that ends capture; the message is for the admin.
#[derive(Debug)]
pub struct CaptureError(pub String);

impl std::fmt::Display for CaptureError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for CaptureError {}

impl CaptureError {
    pub fn new(message: impl Into<String>) -> Self {
        CaptureError(message.into())
    }
}

pub type CaptureResult<T> = Result<T, CaptureError>;

/// One platform's screen capture. A session owns one.
pub trait Capturer: Send {
    /// The displays, in the order the `displays` message lists them.
    fn displays(&self) -> &[DisplayInfo];

    /// Index of the display being captured.
    fn current(&self) -> usize;

    /// Switches to another display. The next capture is a full one.
    fn select(&mut self, index: usize) -> CaptureResult<()>;

    /// Reads platform events. Returns true when the display list or the
    /// current display's size changed; the caller then sends `displays` and
    /// a keyframe.
    fn poll_layout(&mut self) -> CaptureResult<bool>;

    /// Refreshes [`Capturer::frame`] when anything changed since the last
    /// call, or always when `full` is set. Changes keep adding up between
    /// calls, so a skipped tick loses nothing.
    fn capture(&mut self, full: bool) -> CaptureResult<Damage>;

    /// The last captured image of the current display.
    fn frame(&self) -> &Frame;

    /// The pointer's position and shape id.
    fn cursor(&mut self) -> CaptureResult<CursorState>;

    /// The image for a shape id that [`Capturer::cursor`] returned.
    fn cursor_image(&mut self, id: u32) -> CaptureResult<Option<CursorImage>>;

    /// Sign-in screen or desktop, locked, who is signed in.
    fn state(&self) -> DesktopState;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rect_intersection() {
        let a = Rect::new(0, 0, 100, 100);
        assert_eq!(
            a.intersect(&Rect::new(50, 60, 100, 100)),
            Some(Rect::new(50, 60, 50, 40))
        );
        assert_eq!(a.intersect(&Rect::new(100, 0, 10, 10)), None);
        assert_eq!(
            a.intersect(&Rect::new(-10, -10, 20, 20)),
            Some(Rect::new(0, 0, 10, 10))
        );
    }
}
