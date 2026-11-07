//! GDI capture: `BitBlt` from the screen into a DIB section, for when DXGI
//! Desktop Duplication is not available (SPEC-DESKTOP 6.2). GDI cannot say
//! what changed, so every capture is compared tile by tile.

use super::{CaptureError, CaptureResult, Frame, Rect};
use ::windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, ReleaseDC,
    SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS, HBITMAP, HDC,
    HGDIOBJ, SRCCOPY,
};

pub struct GdiGrabber {
    rect: Rect,
    dc: HDC,
    bitmap: HBITMAP,
    previous: HGDIOBJ,
    bits: *mut u8,
}

// SAFETY: the DC, bitmap and bits belong to this value alone and are used
// only through `&mut self`.
unsafe impl Send for GdiGrabber {}

impl GdiGrabber {
    /// A grabber for `rect` on the virtual desktop.
    pub fn new(rect: Rect) -> CaptureResult<GdiGrabber> {
        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: rect.width as i32,
                // Negative: rows top first, as Frame keeps them.
                biHeight: -(rect.height as i32),
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        // SAFETY: a memory DC and a DIB section owned by the new value.
        unsafe {
            let dc = CreateCompatibleDC(None);
            let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
            let bitmap = CreateDIBSection(Some(dc), &info, DIB_RGB_COLORS, &mut bits, None, 0)
                .map_err(|e| {
                    let _ = DeleteDC(dc);
                    CaptureError::new(format!("CreateDIBSection: {e}"))
                })?;
            let previous = SelectObject(dc, HGDIOBJ(bitmap.0));
            Ok(GdiGrabber {
                rect,
                dc,
                bitmap,
                previous,
                bits: bits.cast(),
            })
        }
    }

    pub fn capture(&mut self, frame: &mut Frame) -> CaptureResult<()> {
        let (width, height) = (self.rect.width, self.rect.height);
        if (frame.width, frame.height) != (width, height) {
            *frame = Frame::new(width, height);
        }
        // SAFETY: copies from the screen DC into our DIB, then reads the
        // DIB's `width * height * 4` bytes.
        unsafe {
            let screen = GetDC(None);
            let blit = BitBlt(
                self.dc,
                0,
                0,
                width as i32,
                height as i32,
                Some(screen),
                self.rect.x,
                self.rect.y,
                SRCCOPY | CAPTUREBLT,
            );
            ReleaseDC(None, screen);
            blit.map_err(|e| CaptureError::new(format!("BitBlt: {e}")))?;
            let len = width as usize * height as usize * 4;
            frame.data[..len].copy_from_slice(std::slice::from_raw_parts(self.bits, len));
        }
        Ok(())
    }
}

impl Drop for GdiGrabber {
    fn drop(&mut self) {
        // SAFETY: releasing the handles made in `new`.
        unsafe {
            SelectObject(self.dc, self.previous);
            let _ = DeleteObject(HGDIOBJ(self.bitmap.0));
            let _ = DeleteDC(self.dc);
        }
    }
}
