//! X11 capture on x11rb (SPEC-DESKTOP 6.1): XShm `GetImage` of the selected
//! monitor's rectangle (plain `GetImage` when MIT-SHM 1.2 is missing, as on
//! a remote display), XDamage to find what changed, RandR 1.5 monitors for
//! the display list, XFixes for the cursor.
//!
//! Written for BMuster on x11rb; the approach (one SHM segment per display,
//! damage on the root window) is the usual one for X11 screen sharing.

use super::x11_session::{connect, X11Target};
use super::{
    CaptureError, CaptureResult, Capturer, CursorImage, CursorState, Damage, DesktopState,
    DisplayInfo, Frame, Rect,
};
use std::os::fd::AsRawFd;
use std::ptr::NonNull;
use x11rb::connection::{Connection, RequestConnection};
use x11rb::protocol::damage::{self, ConnectionExt as _};
use x11rb::protocol::randr::{self, ConnectionExt as _};
use x11rb::protocol::shm::{self, ConnectionExt as _};
use x11rb::protocol::xfixes::{self, ConnectionExt as _};
use x11rb::protocol::xproto::{ConnectionExt as _, ImageFormat, ImageOrder, Window};
use x11rb::protocol::Event;
use x11rb::rust_connection::RustConnection;

fn failed<E: std::fmt::Display>(what: &'static str) -> impl FnOnce(E) -> CaptureError {
    move |error| CaptureError(format!("{what}: {error}"))
}

/// A MIT-SHM segment made by the X server (`CreateSegment`, version 1.2) and
/// mapped read-only here. The server creates it, so no other local user can
/// attach to it the way they could to a SysV segment.
struct ShmBuffer {
    segment: shm::Seg,
    data: NonNull<u8>,
    len: usize,
}

// SAFETY: the mapping is owned by this value alone and only read through
// `bytes`, which borrows it; moving it to another thread is fine.
unsafe impl Send for ShmBuffer {}

impl ShmBuffer {
    fn create(connection: &RustConnection, len: usize) -> CaptureResult<ShmBuffer> {
        let segment = connection
            .generate_id()
            .map_err(failed("allocating an SHM id"))?;
        let size = u32::try_from(len).map_err(failed("SHM segment size"))?;
        let reply = connection
            .shm_create_segment(segment, size, false)
            .map_err(failed("ShmCreateSegment"))?
            .reply()
            .map_err(failed("ShmCreateSegment"))?;
        // SAFETY: mapping a fresh shared, read-only view of the fd the server
        // gave us, `len` bytes long (the size we asked for). The result is
        // checked against MAP_FAILED before use.
        let address = unsafe {
            libc::mmap(
                std::ptr::null_mut(),
                len,
                libc::PROT_READ,
                libc::MAP_SHARED,
                reply.shm_fd.as_raw_fd(),
                0,
            )
        };
        if address == libc::MAP_FAILED {
            let _ = connection.shm_detach(segment);
            return Err(CaptureError::new(format!(
                "mapping the SHM segment failed: {}",
                std::io::Error::last_os_error()
            )));
        }
        let data = NonNull::new(address.cast::<u8>())
            .ok_or_else(|| CaptureError::new("mmap returned a null pointer"))?;
        Ok(ShmBuffer { segment, data, len })
    }

    fn bytes(&self) -> &[u8] {
        // SAFETY: `data` points to `len` mapped bytes for as long as `self`
        // lives; the server writes only while we wait for its GetImage reply.
        unsafe { std::slice::from_raw_parts(self.data.as_ptr(), self.len) }
    }
}

impl Drop for ShmBuffer {
    fn drop(&mut self) {
        // SAFETY: unmapping exactly the mapping made in `create`.
        unsafe {
            libc::munmap(self.data.as_ptr().cast(), self.len);
        }
    }
}

pub struct X11Capturer {
    connection: RustConnection,
    root: Window,
    displays: Vec<DisplayInfo>,
    current: usize,
    frame: Frame,
    shm_available: bool,
    shm: Option<ShmBuffer>,
    damage: damage::Damage,
    region: xfixes::Region,
    randr_monitors: bool,
    layout_dirty: bool,
    cursor_serial: u32,
}

impl X11Capturer {
    /// Connects to the target display and sets up damage tracking, RandR
    /// and cursor events.
    pub fn open(target: &X11Target) -> CaptureResult<X11Capturer> {
        let (connection, screen_number) = connect(target).map_err(CaptureError)?;
        let setup = connection.setup();
        let screen = setup
            .roots
            .get(screen_number)
            .ok_or_else(|| CaptureError::new("the X server has no such screen"))?;
        let root = screen.root;
        let depth = screen.root_depth;
        let bits = setup
            .pixmap_formats
            .iter()
            .find(|f| f.depth == depth)
            .map(|f| f.bits_per_pixel);
        if !matches!(depth, 24 | 32)
            || bits != Some(32)
            || setup.image_byte_order != ImageOrder::LSB_FIRST
        {
            return Err(CaptureError::new(format!(
                "unsupported X pixel format (depth {depth}, {bits:?} bits per pixel); \
                 BMuster captures 24-bit colour in 32-bit pixels"
            )));
        }

        let need = |name: &'static str| {
            let present = connection
                .extension_information(name)
                .map_err(failed("querying X extensions"))?
                .is_some();
            if present {
                Ok(())
            } else {
                Err(CaptureError::new(format!(
                    "the X server has no {name} extension"
                )))
            }
        };
        need(xfixes::X11_EXTENSION_NAME)?;
        need(damage::X11_EXTENSION_NAME)?;
        // XFixes must be negotiated before Damage, and regions need XFixes 2.
        connection
            .xfixes_query_version(5, 0)
            .map_err(failed("XFixes version"))?
            .reply()
            .map_err(failed("XFixes version"))?;
        connection
            .damage_query_version(1, 1)
            .map_err(failed("Damage version"))?
            .reply()
            .map_err(failed("Damage version"))?;

        let shm_available = match connection.extension_information(shm::X11_EXTENSION_NAME) {
            Ok(Some(_)) => connection
                .shm_query_version()
                .ok()
                .and_then(|cookie| cookie.reply().ok())
                .is_some_and(|v| (v.major_version, v.minor_version) >= (1, 2)),
            _ => false,
        };
        if !shm_available {
            log::info!("MIT-SHM 1.2 is not available on this display; using plain GetImage");
        }

        let randr_monitors = match connection.extension_information(randr::X11_EXTENSION_NAME) {
            Ok(Some(_)) => connection
                .randr_query_version(1, 5)
                .ok()
                .and_then(|cookie| cookie.reply().ok())
                .is_some_and(|v| (v.major_version, v.minor_version) >= (1, 5)),
            _ => false,
        };
        if randr_monitors {
            connection
                .randr_select_input(
                    root,
                    randr::NotifyMask::SCREEN_CHANGE
                        | randr::NotifyMask::CRTC_CHANGE
                        | randr::NotifyMask::OUTPUT_CHANGE,
                )
                .map_err(failed("RandR events"))?;
        }

        let damage = connection.generate_id().map_err(failed("allocating ids"))?;
        connection
            .damage_create(damage, root, damage::ReportLevel::NON_EMPTY)
            .map_err(failed("DamageCreate"))?;
        let region = connection.generate_id().map_err(failed("allocating ids"))?;
        connection
            .xfixes_create_region(region, &[])
            .map_err(failed("CreateRegion"))?;
        connection
            .xfixes_select_cursor_input(root, xfixes::CursorNotifyMask::DISPLAY_CURSOR)
            .map_err(failed("cursor events"))?;
        let cursor_serial = connection
            .xfixes_get_cursor_image()
            .map_err(failed("GetCursorImage"))?
            .reply()
            .map(|reply| reply.cursor_serial)
            .unwrap_or(0);

        let mut capturer = X11Capturer {
            connection,
            root,
            displays: Vec::new(),
            current: 0,
            frame: Frame::new(0, 0),
            shm_available,
            shm: None,
            damage,
            region,
            randr_monitors,
            layout_dirty: false,
            cursor_serial,
        };
        capturer.displays = capturer.read_displays()?;
        capturer.current = capturer
            .displays
            .iter()
            .position(|d| d.primary)
            .unwrap_or(0);
        capturer.resize_buffers()?;
        Ok(capturer)
    }

    fn read_displays(&self) -> CaptureResult<Vec<DisplayInfo>> {
        if self.randr_monitors {
            let monitors = self
                .connection
                .randr_get_monitors(self.root, true)
                .map_err(failed("GetMonitors"))?
                .reply()
                .map_err(failed("GetMonitors"))?
                .monitors;
            let mut displays = Vec::with_capacity(monitors.len());
            for (index, monitor) in monitors.iter().enumerate() {
                let name = self
                    .connection
                    .get_atom_name(monitor.name)
                    .ok()
                    .and_then(|cookie| cookie.reply().ok())
                    .map(|reply| String::from_utf8_lossy(&reply.name).into_owned())
                    .unwrap_or_else(|| format!("monitor-{index}"));
                if monitor.width == 0 || monitor.height == 0 {
                    continue;
                }
                displays.push(DisplayInfo {
                    id: name.clone(),
                    name,
                    x: i32::from(monitor.x),
                    y: i32::from(monitor.y),
                    width: u32::from(monitor.width),
                    height: u32::from(monitor.height),
                    scale: 1.0,
                    primary: monitor.primary,
                });
            }
            if !displays.is_empty() {
                if !displays.iter().any(|d| d.primary) {
                    displays[0].primary = true;
                }
                return Ok(displays);
            }
        }
        let geometry = self
            .connection
            .get_geometry(self.root)
            .map_err(failed("GetGeometry"))?
            .reply()
            .map_err(failed("GetGeometry"))?;
        Ok(vec![DisplayInfo {
            id: "screen".to_string(),
            name: "Screen".to_string(),
            x: 0,
            y: 0,
            width: u32::from(geometry.width),
            height: u32::from(geometry.height),
            scale: 1.0,
            primary: true,
        }])
    }

    fn current_rect(&self) -> Rect {
        self.displays[self.current].rect()
    }

    fn resize_buffers(&mut self) -> CaptureResult<()> {
        let rect = self.current_rect();
        self.frame = Frame::new(rect.width, rect.height);
        if let Some(old) = self.shm.take() {
            let _ = self.connection.shm_detach(old.segment);
        }
        if self.shm_available {
            let len = rect.width as usize * rect.height as usize * 4;
            match ShmBuffer::create(&self.connection, len) {
                Ok(buffer) => self.shm = Some(buffer),
                Err(error) => {
                    log::warn!("XShm failed ({error}); using plain GetImage");
                    self.shm_available = false;
                }
            }
        }
        Ok(())
    }

    fn drain_events(&mut self) -> CaptureResult<()> {
        while let Some(event) = self
            .connection
            .poll_for_event()
            .map_err(failed("reading X events"))?
        {
            match event {
                Event::RandrScreenChangeNotify(_) | Event::RandrNotify(_) => {
                    self.layout_dirty = true;
                }
                Event::XfixesCursorNotify(notify) => self.cursor_serial = notify.cursor_serial,
                Event::Error(error) => log::debug!("X error during capture: {error:?}"),
                _ => {}
            }
        }
        Ok(())
    }

    /// Takes the damage collected since the last call, in root coordinates.
    fn take_damage(&self) -> CaptureResult<Vec<Rect>> {
        self.connection
            .damage_subtract(self.damage, x11rb::NONE, self.region)
            .map_err(failed("DamageSubtract"))?;
        let rectangles = self
            .connection
            .xfixes_fetch_region(self.region)
            .map_err(failed("FetchRegion"))?
            .reply()
            .map_err(failed("FetchRegion"))?
            .rectangles;
        Ok(rectangles
            .iter()
            .map(|r| {
                Rect::new(
                    i32::from(r.x),
                    i32::from(r.y),
                    u32::from(r.width),
                    u32::from(r.height),
                )
            })
            .collect())
    }

    /// Reads `area` (display-relative) into the frame.
    fn read_area(&mut self, area: Rect) -> CaptureResult<()> {
        let display = self.current_rect();
        let (x, y) = (display.x + area.x, display.y + area.y);
        let (width, height) = (area.width as u16, area.height as u16);
        let row_bytes = area.width as usize * 4;
        let format = u8::from(ImageFormat::Z_PIXMAP);
        if let Some(buffer) = &self.shm {
            self.connection
                .shm_get_image(
                    self.root,
                    x as i16,
                    y as i16,
                    width,
                    height,
                    !0,
                    format,
                    buffer.segment,
                    0,
                )
                .map_err(failed("ShmGetImage"))?
                .reply()
                .map_err(failed("ShmGetImage"))?;
            copy_rows(buffer.bytes(), row_bytes, &mut self.frame, area);
        } else {
            let reply = self
                .connection
                .get_image(
                    ImageFormat::Z_PIXMAP,
                    self.root,
                    x as i16,
                    y as i16,
                    width,
                    height,
                    !0,
                )
                .map_err(failed("GetImage"))?
                .reply()
                .map_err(failed("GetImage"))?;
            copy_rows(&reply.data, row_bytes, &mut self.frame, area);
        }
        Ok(())
    }
}

/// Copies a packed image of `area`'s size into the frame at `area`.
fn copy_rows(source: &[u8], row_bytes: usize, frame: &mut Frame, area: Rect) {
    let start = area.x as usize * 4;
    for (row, y) in (area.y as u32..area.y as u32 + area.height).enumerate() {
        let from = &source[row * row_bytes..(row + 1) * row_bytes];
        frame.row_mut(y)[start..start + row_bytes].copy_from_slice(from);
    }
}

/// Smallest rectangle around all of `rects`.
fn bounding_box(rects: &[Rect]) -> Option<Rect> {
    let first = rects.first()?;
    let (mut left, mut top) = (first.x, first.y);
    let (mut right, mut bottom) = (first.x + first.width as i32, first.y + first.height as i32);
    for r in &rects[1..] {
        left = left.min(r.x);
        top = top.min(r.y);
        right = right.max(r.x + r.width as i32);
        bottom = bottom.max(r.y + r.height as i32);
    }
    Some(Rect::new(
        left,
        top,
        (right - left) as u32,
        (bottom - top) as u32,
    ))
}

impl Capturer for X11Capturer {
    fn displays(&self) -> &[DisplayInfo] {
        &self.displays
    }

    fn current(&self) -> usize {
        self.current
    }

    fn select(&mut self, index: usize) -> CaptureResult<()> {
        if index >= self.displays.len() {
            return Err(CaptureError::new("no such display"));
        }
        self.current = index;
        self.resize_buffers()
    }

    fn poll_layout(&mut self) -> CaptureResult<bool> {
        self.drain_events()?;
        if !std::mem::take(&mut self.layout_dirty) {
            return Ok(false);
        }
        let displays = self.read_displays()?;
        if displays == self.displays {
            return Ok(false);
        }
        let current_id = self.displays[self.current].id.clone();
        self.current = displays
            .iter()
            .position(|d| d.id == current_id)
            .or_else(|| displays.iter().position(|d| d.primary))
            .unwrap_or(0);
        self.displays = displays;
        self.resize_buffers()?;
        Ok(true)
    }

    fn capture(&mut self, full: bool) -> CaptureResult<Damage> {
        self.drain_events()?;
        let display = self.current_rect();
        let changed: Vec<Rect> = self
            .take_damage()?
            .iter()
            .filter_map(|r| r.intersect(&display))
            .map(|r| r.offset(display.x, display.y))
            .collect();
        if full {
            self.read_area(Rect::new(0, 0, display.width, display.height))?;
            return Ok(Damage::Unknown);
        }
        let Some(area) = bounding_box(&changed) else {
            return Ok(Damage::None);
        };
        self.read_area(area)?;
        Ok(Damage::Rects(changed))
    }

    fn frame(&self) -> &Frame {
        &self.frame
    }

    fn cursor(&mut self) -> CaptureResult<CursorState> {
        self.drain_events()?;
        let pointer = self
            .connection
            .query_pointer(self.root)
            .map_err(failed("QueryPointer"))?
            .reply()
            .map_err(failed("QueryPointer"))?;
        Ok(CursorState {
            id: self.cursor_serial,
            x: i32::from(pointer.root_x),
            y: i32::from(pointer.root_y),
            visible: pointer.same_screen,
        })
    }

    fn cursor_image(&mut self, id: u32) -> CaptureResult<Option<CursorImage>> {
        let reply = self
            .connection
            .xfixes_get_cursor_image()
            .map_err(failed("GetCursorImage"))?
            .reply()
            .map_err(failed("GetCursorImage"))?;
        if reply.cursor_serial != id {
            self.cursor_serial = reply.cursor_serial;
            return Ok(None);
        }
        Ok(Some(CursorImage {
            width: u32::from(reply.width),
            height: u32::from(reply.height),
            hotspot_x: u32::from(reply.xhot),
            hotspot_y: u32::from(reply.yhot),
            rgba: unpremultiply_argb(&reply.cursor_image),
        }))
    }

    /// The session that follows seat0 reports the state from logind; the
    /// X connection cannot tell a greeter from a desktop.
    fn state(&self) -> DesktopState {
        DesktopState::Desktop { user: None }
    }

    fn backend(&self) -> &'static str {
        "x11"
    }
}

impl Drop for X11Capturer {
    fn drop(&mut self) {
        if let Some(buffer) = self.shm.take() {
            let _ = self.connection.shm_detach(buffer.segment);
        }
        let _ = self.connection.damage_destroy(self.damage);
        let _ = self.connection.xfixes_destroy_region(self.region);
        let _ = self.connection.flush();
    }
}

/// XFixes cursor pixels (premultiplied ARGB in a u32) to straight RGBA bytes.
pub fn unpremultiply_argb(pixels: &[u32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(pixels.len() * 4);
    for &pixel in pixels {
        let alpha = (pixel >> 24) & 0xFF;
        let channel = |shift: u32| {
            let value = (pixel >> shift) & 0xFF;
            if alpha == 0 {
                0
            } else {
                ((value * 255 + alpha / 2) / alpha).min(255) as u8
            }
        };
        out.extend_from_slice(&[channel(16), channel(8), channel(0), alpha as u8]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursor_pixels_are_unpremultiplied() {
        assert_eq!(
            unpremultiply_argb(&[0xFF_10_20_30, 0x80_40_00_80, 0]),
            vec![0x10, 0x20, 0x30, 0xFF, 0x80, 0, 0xFF, 0x80, 0, 0, 0, 0]
        );
    }

    #[test]
    fn damage_bounding_box() {
        assert_eq!(
            bounding_box(&[Rect::new(10, 10, 5, 5), Rect::new(0, 20, 2, 2)]),
            Some(Rect::new(0, 10, 15, 12))
        );
        assert_eq!(bounding_box(&[]), None);
    }
}
