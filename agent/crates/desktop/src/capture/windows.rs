//! Windows capture (SPEC-DESKTOP 6.2): DXGI Desktop Duplication, falling
//! back to GDI `BitBlt` when DXGI cannot start or fails (RDP-attached
//! sessions, some VMs, old drivers). Phase 1 covers the Default desktop; the
//! helper process that runs this in the console session, and following the
//! input desktop, come with phase 3.
//!
//! The display list and the cursor come from user32 for both paths, so a
//! switch from DXGI to GDI keeps the same display ids.

use super::dxgi::Duplication;
use super::gdi::GdiGrabber;
use super::{
    CaptureError, CaptureResult, Capturer, CursorImage, CursorState, Damage, DesktopState,
    DisplayInfo, Frame,
};
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

pub struct WindowsCapturer {
    displays: Vec<DisplayInfo>,
    current: usize,
    frame: Frame,
    grabber: Grabber,
    /// The next capture must be full (new grabber).
    fresh: bool,
}

/// Opens capture on the primary display.
pub fn open() -> CaptureResult<Box<dyn Capturer>> {
    let displays = list_displays()?;
    let current = displays.iter().position(|d| d.primary).unwrap_or(0);
    let grabber = start_grabber(&displays[current])?;
    let rect = displays[current].rect();
    Ok(Box::new(WindowsCapturer {
        frame: Frame::new(rect.width, rect.height),
        displays,
        current,
        grabber,
        fresh: true,
    }))
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
        let display = &self.displays[self.current];
        let rect = display.rect();
        self.frame = Frame::new(rect.width, rect.height);
        self.grabber = start_grabber(display)?;
        self.fresh = true;
        Ok(())
    }
}

impl Capturer for WindowsCapturer {
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
        self.restart()
    }

    fn poll_layout(&mut self) -> CaptureResult<bool> {
        let displays = list_displays()?;
        if displays == self.displays {
            return Ok(false);
        }
        let id = self.displays[self.current].id.clone();
        self.current = displays
            .iter()
            .position(|d| d.id == id)
            .or_else(|| displays.iter().position(|d| d.primary))
            .unwrap_or(0);
        self.displays = displays;
        self.restart()?;
        Ok(true)
    }

    fn capture(&mut self, full: bool) -> CaptureResult<Damage> {
        let full = full || std::mem::take(&mut self.fresh);
        let result = match &mut self.grabber {
            Grabber::Dxgi(duplication) => duplication.capture(&mut self.frame, full),
            Grabber::Gdi(gdi) => gdi.capture(&mut self.frame).map(|()| Damage::Unknown),
        };
        match result {
            Ok(damage) => Ok(damage),
            Err(error) if matches!(self.grabber, Grabber::Dxgi(_)) => {
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
}

/// Renders a cursor on black and on white and works out each pixel's
/// alpha from the difference, so colour, alpha and monochrome cursors all
/// come out as straight RGBA. Inverting pixels come out as white.
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
    let mut rgba = Vec::with_capacity(on_black.len());
    for (b, w) in on_black.chunks_exact(4).zip(on_white.chunks_exact(4)) {
        // Over black a pixel shows c*a; over white c*a + (1-a). So
        // a = 1 - (white - black), per channel; green is representative.
        let alpha = 255 - (i32::from(w[1]) - i32::from(b[1])).clamp(0, 255);
        let channel = |value: u8| {
            if alpha == 0 {
                0
            } else {
                ((i32::from(value) * 255 + alpha / 2) / alpha).min(255) as u8
            }
        };
        rgba.extend_from_slice(&[channel(b[2]), channel(b[1]), channel(b[0]), alpha as u8]);
    }
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
