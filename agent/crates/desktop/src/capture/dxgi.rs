//! DXGI Desktop Duplication for one output (SPEC-DESKTOP 6.2).
//!
//! Written for BMuster from Microsoft's Desktop Duplication API
//! documentation; no RustDesk (`scrap`) code is used. Each capture acquires
//! the next desktop image (without waiting), reads the dirty and move
//! rectangles, and copies the image to the CPU through a staging texture.
//! Updates keep accumulating in DXGI while the session skips ticks.

use super::{CaptureError, CaptureResult, Damage, DisplayInfo, Frame, Rect};
use ::windows::core::Interface;
use ::windows::Win32::Foundation::{HMODULE, RECT};
use ::windows::Win32::Graphics::Direct3D::D3D_DRIVER_TYPE_UNKNOWN;
use ::windows::Win32::Graphics::Direct3D11::{
    D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D, D3D11_CPU_ACCESS_READ,
    D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAPPED_SUBRESOURCE, D3D11_MAP_READ, D3D11_SDK_VERSION,
    D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
};
use ::windows::Win32::Graphics::Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC};
use ::windows::Win32::Graphics::Dxgi::{
    CreateDXGIFactory1, IDXGIFactory1, IDXGIOutput, IDXGIOutput1, IDXGIOutputDuplication,
    IDXGIResource, DXGI_ERROR_NOT_FOUND, DXGI_ERROR_WAIT_TIMEOUT, DXGI_OUTDUPL_FRAME_INFO,
    DXGI_OUTDUPL_MOVE_RECT,
};

fn failed<E: std::fmt::Display>(what: &'static str) -> impl FnOnce(E) -> CaptureError {
    move |error| CaptureError(format!("{what}: {error}"))
}

pub struct Duplication {
    /// Kept so the device lives as long as its duplication and texture.
    _device: ID3D11Device,
    context: ID3D11DeviceContext,
    duplication: IDXGIOutputDuplication,
    staging: ID3D11Texture2D,
    width: u32,
    height: u32,
    metadata: Vec<u8>,
}

/// The adapter output whose device name is the display's id.
fn find_output(
    display: &DisplayInfo,
) -> CaptureResult<(::windows::Win32::Graphics::Dxgi::IDXGIAdapter1, IDXGIOutput)> {
    // SAFETY: plain COM calls; every returned interface is reference counted.
    unsafe {
        let factory: IDXGIFactory1 = CreateDXGIFactory1().map_err(failed("CreateDXGIFactory1"))?;
        for adapter_index in 0.. {
            let adapter = match factory.EnumAdapters1(adapter_index) {
                Ok(adapter) => adapter,
                Err(e) if e.code() == DXGI_ERROR_NOT_FOUND => break,
                Err(e) => return Err(failed("EnumAdapters1")(e)),
            };
            for output_index in 0.. {
                let output = match adapter.EnumOutputs(output_index) {
                    Ok(output) => output,
                    Err(_) => break,
                };
                let desc = output.GetDesc().map_err(failed("IDXGIOutput::GetDesc"))?;
                if super::windows::wide_to_string(&desc.DeviceName) == display.id {
                    return Ok((adapter, output));
                }
            }
        }
    }
    Err(CaptureError::new(format!(
        "no DXGI output for display {}",
        display.id
    )))
}

impl Duplication {
    pub fn new(display: &DisplayInfo) -> CaptureResult<Duplication> {
        let (adapter, output) = find_output(display)?;
        // SAFETY: COM calls with out-parameters that live across each call.
        unsafe {
            let mut device = None;
            let mut context = None;
            D3D11CreateDevice(
                &adapter,
                D3D_DRIVER_TYPE_UNKNOWN,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )
            .map_err(failed("D3D11CreateDevice"))?;
            let device: ID3D11Device =
                device.ok_or_else(|| CaptureError::new("D3D11CreateDevice gave no device"))?;
            let context: ID3D11DeviceContext =
                context.ok_or_else(|| CaptureError::new("D3D11CreateDevice gave no context"))?;
            let output1: IDXGIOutput1 = output.cast().map_err(failed("IDXGIOutput1"))?;
            let duplication = output1
                .DuplicateOutput(&device)
                .map_err(failed("DuplicateOutput"))?;
            let mode = duplication.GetDesc().ModeDesc;
            let (width, height) = (mode.Width, mode.Height);
            let desc = D3D11_TEXTURE2D_DESC {
                Width: width,
                Height: height,
                MipLevels: 1,
                ArraySize: 1,
                Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                SampleDesc: DXGI_SAMPLE_DESC {
                    Count: 1,
                    Quality: 0,
                },
                Usage: D3D11_USAGE_STAGING,
                BindFlags: 0,
                CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
                MiscFlags: 0,
            };
            let mut staging = None;
            device
                .CreateTexture2D(&desc, None, Some(&mut staging))
                .map_err(failed("CreateTexture2D"))?;
            let staging =
                staging.ok_or_else(|| CaptureError::new("CreateTexture2D gave no texture"))?;
            Ok(Duplication {
                _device: device,
                context,
                duplication,
                staging,
                width,
                height,
                metadata: Vec::new(),
            })
        }
    }

    /// Takes the next desktop image if there is one. With `full`, the frame
    /// is refreshed even when DXGI reports no change (it holds the last image).
    pub fn capture(&mut self, frame: &mut Frame, full: bool) -> CaptureResult<Damage> {
        if (frame.width, frame.height) != (self.width, self.height) {
            *frame = Frame::new(self.width, self.height);
        }
        let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
        let mut resource: Option<IDXGIResource> = None;
        // SAFETY: COM calls; the acquired frame is released on every path below.
        unsafe {
            match self
                .duplication
                .AcquireNextFrame(0, &mut info, &mut resource)
            {
                Ok(()) => {}
                Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => {
                    return Ok(if full { Damage::Unknown } else { Damage::None });
                }
                Err(e) => return Err(failed("AcquireNextFrame")(e)),
            }
            let result = self.read_frame(&info, resource, frame);
            let released = self.duplication.ReleaseFrame();
            let damage = result?;
            released.map_err(failed("ReleaseFrame"))?;
            Ok(match damage {
                Damage::None if full => Damage::Unknown,
                other => other,
            })
        }
    }

    unsafe fn read_frame(
        &mut self,
        info: &DXGI_OUTDUPL_FRAME_INFO,
        resource: Option<IDXGIResource>,
        frame: &mut Frame,
    ) -> CaptureResult<Damage> {
        // Only the pointer moved: the image is unchanged.
        if info.LastPresentTime == 0 || info.AccumulatedFrames == 0 {
            return Ok(Damage::None);
        }
        let resource =
            resource.ok_or_else(|| CaptureError::new("AcquireNextFrame gave no image"))?;
        let damage = if info.TotalMetadataBufferSize > 0 {
            Damage::Rects(unsafe { self.changed_rects(info.TotalMetadataBufferSize)? })
        } else {
            Damage::Unknown
        };
        let texture: ID3D11Texture2D = resource.cast().map_err(failed("desktop texture"))?;
        unsafe {
            self.context.CopyResource(&self.staging, &texture);
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            self.context
                .Map(&self.staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
                .map_err(failed("Map"))?;
            let pitch = mapped.RowPitch as usize;
            let row_bytes = self.width as usize * 4;
            let source =
                std::slice::from_raw_parts(mapped.pData.cast::<u8>(), pitch * self.height as usize);
            for y in 0..self.height {
                let start = y as usize * pitch;
                frame
                    .row_mut(y)
                    .copy_from_slice(&source[start..start + row_bytes]);
            }
            self.context.Unmap(&self.staging, 0);
        }
        Ok(damage)
    }

    /// Dirty rectangles plus the destinations of moved areas.
    unsafe fn changed_rects(&mut self, size: u32) -> CaptureResult<Vec<Rect>> {
        self.metadata.resize(size as usize, 0);
        let mut rects = Vec::new();
        let mut used = 0u32;
        unsafe {
            self.duplication
                .GetFrameMoveRects(
                    size,
                    self.metadata.as_mut_ptr().cast::<DXGI_OUTDUPL_MOVE_RECT>(),
                    &mut used,
                )
                .map_err(failed("GetFrameMoveRects"))?;
            let moves = std::slice::from_raw_parts(
                self.metadata.as_ptr().cast::<DXGI_OUTDUPL_MOVE_RECT>(),
                used as usize / std::mem::size_of::<DXGI_OUTDUPL_MOVE_RECT>(),
            );
            rects.extend(moves.iter().map(|m| to_rect(&m.DestinationRect)));
            self.duplication
                .GetFrameDirtyRects(size, self.metadata.as_mut_ptr().cast::<RECT>(), &mut used)
                .map_err(failed("GetFrameDirtyRects"))?;
            let dirty = std::slice::from_raw_parts(
                self.metadata.as_ptr().cast::<RECT>(),
                used as usize / std::mem::size_of::<RECT>(),
            );
            rects.extend(dirty.iter().map(to_rect));
        }
        Ok(rects)
    }
}

fn to_rect(r: &RECT) -> Rect {
    Rect::new(
        r.left,
        r.top,
        (r.right - r.left).max(0) as u32,
        (r.bottom - r.top).max(0) as u32,
    )
}
