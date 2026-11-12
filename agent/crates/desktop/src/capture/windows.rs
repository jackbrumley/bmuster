//! Windows capture (SPEC-DESKTOP 6.2): DXGI Desktop Duplication, falling
//! back to GDI `BitBlt` when DXGI cannot start or fails (RDP-attached
//! sessions, some VMs, old drivers, often the Winlogon desktop). It runs in
//! the desktop helper on the desktop its thread is on; following the input
//! desktop is [`super::windows_follow`]. A capturer whose desktop is no
//! longer the input desktop fails its next poll, so the following session
//! looks again at once.
//!
//! The display list and the cursor come from user32 for both paths, so a
//! switch from DXGI to GDI keeps the same display ids. All screens
//! (SPEC-DESKTOP-ALL-SCREENS) runs one grabber per display and draws each
//! image at its place on the virtual screen, which `SendInput` spans too.

use super::combined::Combined;
use super::dxgi::Duplication;
use super::gdi::GdiGrabber;
use super::{
    keep_view, primary_view, CaptureError, CaptureResult, Capturer, CursorImage, CursorState,
    Damage, DesktopState, DisplayInfo, Frame, View,
};
use crate::winsession::input_desktop;
use ::windows::core::BOOL;
use ::windows::Win32::Foundation::{LPARAM, RECT};
use ::windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, EnumDisplayMonitors,
    GetMonitorInfoW, GetObjectW, SelectObject, BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
    DIB_RGB_COLORS, HDC, HGDIOBJ, HMONITOR, MONITORINFO, MONITORINFOEXW,
};
use ::windows::Win32::UI::WindowsAndMessaging::{
    DrawIconEx, GetCursorInfo, GetIconInfo, CURSORINFO, CURSOR_SHOWING, DI_NORMAL, HICON, ICONINFO,
    MONITORINFOF_PRIMARY,
};

enum Grabber {
    Dxgi(Duplication),
    Gdi(GdiGrabber),
}

impl Grabber {
    fn capture(&mut self, frame: &mut Frame, full: bool) -> CaptureResult<Damage> {
        match self {
            Grabber::Dxgi(duplication) => duplication.capture(frame, full),
            Grabber::Gdi(gdi) => gdi.capture(frame).map(|()| Damage::Unknown),
        }
    }

    fn is_dxgi(&self) -> bool {
        matches!(self, Grabber::Dxgi(_))
    }
}

/// What is being grabbed: one display, or every display with its own
/// grabber and image, drawn into one frame at its place on the virtual
/// screen (SPEC-DESKTOP-ALL-SCREENS).
enum Grabbing {
    One(Grabber),
    All {
        combined: Combined,
        parts: Vec<(Grabber, Frame)>,
    },
}

pub struct WindowsCapturer {
    displays: Vec<DisplayInfo>,
    view: View,
    frame: Frame,
    grabbing: Grabbing,
    /// The next capture must be full (new grabber).
    fresh: bool,
    /// The desktop this capturer opened on (the input desktop then).
    desktop: String,
}

/// Opens capture on the primary display.
pub fn open() -> CaptureResult<Box<dyn Capturer>> {
    let displays = list_displays()?;
    let view = primary_view(&displays);
    let (grabbing, frame) = start(&displays, view)?;
    Ok(Box::new(WindowsCapturer {
        frame,
        displays,
        view,
        grabbing,
        fresh: true,
        desktop: input_desktop::input_desktop_name().unwrap_or_default(),
    }))
}

/// Grabbers for `view`, and a black frame of its size.
fn start(displays: &[DisplayInfo], view: View) -> CaptureResult<(Grabbing, Frame)> {
    match view {
        View::Display(index) => {
            let display = displays
                .get(index)
                .ok_or_else(|| CaptureError::new("no such display"))?;
            let rect = display.rect();
            Ok((
                Grabbing::One(start_grabber(display)?),
                Frame::new(rect.width, rect.height),
            ))
        }
        View::All => {
            let combined = Combined::new(displays)
                .ok_or_else(|| CaptureError::new("These displays cannot be shown all at once"))?;
            let parts = displays
                .iter()
                .map(|display| {
                    let rect = display.rect();
                    Ok((start_grabber(display)?, Frame::new(rect.width, rect.height)))
                })
                .collect::<CaptureResult<Vec<_>>>()?;
            let frame = combined.blank();
            Ok((Grabbing::All { combined, parts }, frame))
        }
    }
}

fn start_grabber(display: &DisplayInfo) -> CaptureResult<Grabber> {
    match Duplication::new(display) {
        Ok(duplication) => Ok(Grabber::Dxgi(duplication)),
        Err(error) => {
            log::warn!("DXGI Desktop Duplication failed ({error}); using GDI");
            Ok(Grabber::Gdi(GdiGrabber::new(display.rect())?))
        }
    }
}

unsafe extern "system" fn collect_monitor(
    monitor: HMONITOR,
    _dc: HDC,
    _rect: *mut RECT,
    data: LPARAM,
) -> BOOL {
    // SAFETY: `data` is the `&mut Vec<HMONITOR>` passed by `list_displays`,
    // alive for the whole EnumDisplayMonitors call.
    let monitors = unsafe { &mut *(data.0 as *mut Vec<HMONITOR>) };
    monitors.push(monitor);
    BOOL(1)
}

/// Every monitor on the desktop, as `\\.\DISPLAYn` device names.
pub fn list_displays() -> CaptureResult<Vec<DisplayInfo>> {
    let mut monitors: Vec<HMONITOR> = Vec::new();
    // SAFETY: the callback only pushes into `monitors`, which outlives the call.
    let ok = unsafe {
        EnumDisplayMonitors(
            None,
            None,
            Some(collect_monitor),
            LPARAM(&mut monitors as *mut Vec<HMONITOR> as isize),
        )
    };
    if !ok.as_bool() {
        return Err(CaptureError::new("EnumDisplayMonitors failed"));
    }
    let mut displays = Vec::new();
    for monitor in monitors {
        let mut info = MONITORINFOEXW {
            monitorInfo: MONITORINFO {
                cbSize: std::mem::size_of::<MONITORINFOEXW>() as u32,
                ..Default::default()
            },
            ..Default::default()
        };
        // SAFETY: `info` is a MONITORINFOEXW with cbSize set, as the call requires.
        let ok = unsafe {
            GetMonitorInfoW(
                monitor,
                &mut info as *mut MONITORINFOEXW as *mut MONITORINFO,
            )
        };
        if !ok.as_bool() {
            continue;
        }
        let r = info.monitorInfo.rcMonitor;
        let id = wide_to_string(&info.szDevice);
        displays.push(DisplayInfo {
            name: id.trim_start_matches("\\\\.\\").to_string(),
            id,
            x: r.left,
            y: r.top,
            width: (r.right - r.left).max(0) as u32,
            height: (r.bottom - r.top).max(0) as u32,
            scale: 1.0,
            primary: info.monitorInfo.dwFlags & MONITORINFOF_PRIMARY != 0,
        });
    }
    if displays.is_empty() {
        return Err(CaptureError::new("no displays attached to this desktop"));
    }
    Ok(displays)
}

pub fn wide_to_string(wide: &[u16]) -> String {
    let end = wide.iter().position(|&c| c == 0).unwrap_or(wide.len());
    String::from_utf16_lossy(&wide[..end])
}

impl WindowsCapturer {
    fn restart(&mut self) -> CaptureResult<()> {
        let (grabbing, frame) = start(&self.displays, self.view)?;
        self.grabbing = grabbing;
        self.frame = frame;
        self.fresh = true;
        Ok(())
    }

    fn grab(&mut self, full: bool) -> CaptureResult<Damage> {
        match &mut self.grabbing {
            Grabbing::One(grabber) => grabber.capture(&mut self.frame, full),
            Grabbing::All { combined, parts } => {
                let mut changed = Vec::new();
                for (index, (grabber, image)) in parts.iter_mut().enumerate() {
                    let damage = grabber.capture(image, full)?;
                    if damage == Damage::None {
                        continue;
                    }
                    combined.draw(&mut self.frame, index, image);
                    if let Damage::Rects(rects) =
                        combined.damage(index, (image.width, image.height), &damage)
                    {
                        changed.extend(rects);
                    }
                }
                Ok(if changed.is_empty() {
                    Damage::None
                } else {
                    Damage::Rects(changed)
                })
            }
        }
    }

    fn uses_dxgi(&self) -> bool {
        match &self.grabbing {
            Grabbing::One(grabber) => grabber.is_dxgi(),
            Grabbing::All { parts, .. } => parts.iter().any(|(grabber, _)| grabber.is_dxgi()),
        }
    }
}

impl Capturer for WindowsCapturer {
    fn displays(&self) -> &[DisplayInfo] {
        &self.displays
    }

    fn view(&self) -> View {
        self.view
    }

    /// Monitor rectangles are on the virtual screen, which `SendInput`
    /// spans too.
    fn can_show_all(&self) -> bool {
        Combined::possible(&self.displays)
    }

    fn select(&mut self, view: View) -> CaptureResult<()> {
        match view {
            View::Display(index) if index >= self.displays.len() => {
                return Err(CaptureError::new("no such display"));
            }
            View::All if !self.can_show_all() => {
                return Err(CaptureError::new(
                    "These displays cannot be shown all at once",
                ));
            }
            _ => {}
        }
        self.view = view;
        self.restart()
    }

    fn poll_layout(&mut self) -> CaptureResult<bool> {
        // Capture and SendInput reach only the desktop the calling thread is
        // on, and the session may poll from another thread than the one that
        // opened this capturer: move this thread to the input desktop. If
        // that is another desktop (lock, sign-in, a UAC prompt), the screen
        // changed and the following session reopens on it.
        if let Ok((input, _)) = input_desktop::follow_input_desktop() {
            if !self.desktop.is_empty() && input != self.desktop {
                return Err(CaptureError::new(format!(
                    "the screen switched from the {} desktop to {input}",
                    self.desktop
                )));
            }
        }
        let displays = list_displays()?;
        if displays == self.displays {
            return Ok(false);
        }
        self.view = keep_view(&self.displays, self.view, &displays);
        self.displays = displays;
        self.restart()?;
        Ok(true)
    }

    fn capture(&mut self, full: bool) -> CaptureResult<Damage> {
        let full = full || std::mem::take(&mut self.fresh);
        match self.grab(full) {
            Ok(damage) => Ok(damage),
            Err(error) if self.uses_dxgi() => {
                // Access lost (mode change, desktop switch, full-screen app):
                // start again, on GDI if DXGI no longer starts.
                log::info!("DXGI capture stopped ({error}); restarting");
                self.restart()?;
                Ok(Damage::Unknown)
            }
            Err(error) => Err(error),
        }
    }

    fn frame(&self) -> &Frame {
        &self.frame
    }

    fn cursor(&mut self) -> CaptureResult<CursorState> {
        let mut info = CURSORINFO {
            cbSize: std::mem::size_of::<CURSORINFO>() as u32,
            ..Default::default()
        };
        // SAFETY: `info` has cbSize set, as GetCursorInfo requires.
        unsafe { GetCursorInfo(&mut info) }
            .map_err(|e| CaptureError::new(format!("GetCursorInfo: {e}")))?;
        Ok(CursorState {
            // The handle identifies the shape; system cursors keep theirs.
            id: info.hCursor.0 as usize as u32,
            x: info.ptScreenPos.x,
            y: info.ptScreenPos.y,
            visible: info.flags.0 & CURSOR_SHOWING.0 != 0 && !info.hCursor.is_invalid(),
        })
    }

    fn cursor_image(&mut self, id: u32) -> CaptureResult<Option<CursorImage>> {
        let mut info = CURSORINFO {
            cbSize: std::mem::size_of::<CURSORINFO>() as u32,
            ..Default::default()
        };
        // SAFETY: as in `cursor`.
        unsafe { GetCursorInfo(&mut info) }
            .map_err(|e| CaptureError::new(format!("GetCursorInfo: {e}")))?;
        if info.hCursor.0 as usize as u32 != id || info.hCursor.is_invalid() {
            return Ok(None);
        }
        cursor_rgba(HICON(info.hCursor.0)).map(Some)
    }

    fn state(&self) -> DesktopState {
        DesktopState::Desktop { user: None }
    }

    fn backend(&self) -> &'static str {
        if self.uses_dxgi() {
            "dxgi"
        } else {
            "gdi"
        }
    }
}

/// Renders a cursor on black and on white and works out each pixel's
/// alpha from the difference, so colour, alpha and monochrome cursors all
/// come out as straight RGBA. Inverting pixels (the text I-beam) come out
/// black with a white outline (`cursor_pixels`, SPEC-DESKTOP 19).
fn cursor_rgba(icon: HICON) -> CaptureResult<CursorImage> {
    let mut icon_info = ICONINFO::default();
    // SAFETY: `icon` is the current cursor handle; ICONINFO is plain data.
    unsafe { GetIconInfo(icon, &mut icon_info) }
        .map_err(|e| CaptureError::new(format!("GetIconInfo: {e}")))?;
    let delete = |object: HGDIOBJ| {
        if !object.is_invalid() {
            // SAFETY: GetIconInfo made these bitmaps for us to delete.
            unsafe {
                let _ = DeleteObject(object);
            }
        }
    };
    let mut mask = BITMAP::default();
    // SAFETY: reads the mask bitmap's header into `mask`.
    unsafe {
        GetObjectW(
            HGDIOBJ(icon_info.hbmMask.0),
            std::mem::size_of::<BITMAP>() as i32,
            Some(&mut mask as *mut BITMAP as *mut _),
        );
    }
    let width = mask.bmWidth.max(1);
    // A monochrome cursor's mask holds the AND and XOR halves stacked.
    let height = if icon_info.hbmColor.is_invalid() {
        (mask.bmHeight / 2).max(1)
    } else {
        mask.bmHeight.max(1)
    };
    delete(HGDIOBJ(icon_info.hbmMask.0));
    delete(HGDIOBJ(icon_info.hbmColor.0));

    let on_black = render_icon(icon, width, height, 0x00)?;
    let on_white = render_icon(icon, width, height, 0xFF)?;
    let rgba =
        super::cursor_pixels::cursor_rgba(&on_black, &on_white, width as usize, height as usize);
    Ok(CursorImage {
        width: width as u32,
        height: height as u32,
        hotspot_x: icon_info.xHotspot,
        hotspot_y: icon_info.yHotspot,
        rgba,
    })
}

/// Draws `icon` over a solid background into a 32-bit DIB; returns BGRA rows.
fn render_icon(icon: HICON, width: i32, height: i32, background: u8) -> CaptureResult<Vec<u8>> {
    let info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: width,
            biHeight: -height,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };
    let len = width as usize * height as usize * 4;
    // SAFETY: a memory DC and a top-down 32-bit DIB section of `len` bytes;
    // every handle made here is released before returning.
    unsafe {
        let dc = CreateCompatibleDC(None);
        let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
        let bitmap = match CreateDIBSection(Some(dc), &info, DIB_RGB_COLORS, &mut bits, None, 0) {
            Ok(bitmap) => bitmap,
            Err(e) => {
                let _ = DeleteDC(dc);
                return Err(CaptureError::new(format!("CreateDIBSection: {e}")));
            }
        };
        let old = SelectObject(dc, HGDIOBJ(bitmap.0));
        std::ptr::write_bytes(bits.cast::<u8>(), background, len);
        let drawn = DrawIconEx(dc, 0, 0, icon, width, height, 0, None, DI_NORMAL);
        let pixels = std::slice::from_raw_parts(bits.cast::<u8>(), len).to_vec();
        SelectObject(dc, old);
        let _ = DeleteObject(HGDIOBJ(bitmap.0));
        let _ = DeleteDC(dc);
        drawn.map_err(|e| CaptureError::new(format!("DrawIconEx: {e}")))?;
        Ok(pixels)
    }
}

/// The desktop helper's capture checks (SPEC-DIAGNOSTICS 1): DXGI Desktop
/// Duplication and GDI on every display, one full frame's size each. The
/// pixels are dropped here.
pub fn check_capture() -> (Result<String, String>, Result<String, String>) {
    let displays = match list_displays() {
        Ok(displays) => displays,
        Err(error) => return (Err(error.0.clone()), Err(error.0)),
    };
    let mut dxgi = Vec::new();
    let mut gdi = Vec::new();
    let mut dxgi_failed = None;
    let mut gdi_failed = None;
    for display in &displays {
        let rect = display.rect();
        let mut frame = Frame::new(rect.width, rect.height);
        match Duplication::new(display).and_then(|mut d| d.capture(&mut frame, true)) {
            Ok(_) => dxgi.push(format!("{} {}x{}", display.id, frame.width, frame.height)),
            Err(error) => dxgi_failed = Some(format!("{}: {error}", display.id)),
        }
        let mut frame = Frame::new(rect.width, rect.height);
        match GdiGrabber::new(rect).and_then(|mut g| g.capture(&mut frame)) {
            Ok(()) => gdi.push(format!("{} {}x{}", display.id, frame.width, frame.height)),
            Err(error) => gdi_failed = Some(format!("{}: {error}", display.id)),
        }
    }
    let outcome = |sizes: Vec<String>, failed: Option<String>| match failed {
        Some(reason) => Err(reason),
        None if sizes.is_empty() => Err("No displays".to_string()),
        None => Ok(format!("One frame of {}.", sizes.join(", "))),
    };
    (outcome(dxgi, dxgi_failed), outcome(gdi, gdi_failed))
}
