//! EGL: missing libraries are reported, and (by hand, on a GPU) buffers
//! in every tiled layout the driver offers read back exactly, and planes
//! compose as the CPU path draws them.

use super::super::compose::{self, CpuLayer, Layer, Placement, OPAQUE, ROTATE_0};
use super::super::SourceRect;
use super::*;
use crate::capture::Rect;
use std::os::fd::{AsFd, FromRawFd, OwnedFd};

#[test]
fn missing_libraries_reported() {
    let missing = Libraries {
        egl: "libbmuster-no-such-egl.so.1",
        ..LIBRARIES
    };
    let error = Gpu::open_with(&missing, Path::new("/dev/dri/renderD128"))
        .err()
        .expect("a missing library is an error, not a crash");
    assert!(error.contains("libbmuster-no-such-egl.so.1"), "{error}");
    let missing = Libraries {
        gbm: "libbmuster-no-such-gbm.so.1",
        ..LIBRARIES
    };
    if let Err(error) = Gpu::open_with(&missing, Path::new("/dev/dri/renderD128")) {
        // EGL and GLES may be missing on the test machine too; whichever
        // is first is named.
        assert!(error.contains("could not be loaded"), "{error}");
    }
}

functions!(GbmBuffers {
    create = "gbm_bo_create": fn(*mut c_void, u32, u32, u32, u32) -> *mut c_void;
    create_with_modifiers = "gbm_bo_create_with_modifiers": fn(*mut c_void, u32, u32, u32, *const u64, u32) -> *mut c_void;
    map = "gbm_bo_map": fn(*mut c_void, u32, u32, u32, u32, u32, *mut u32, *mut *mut c_void) -> *mut c_void;
    unmap = "gbm_bo_unmap": fn(*mut c_void, *mut c_void);
    plane_count = "gbm_bo_get_plane_count": fn(*mut c_void) -> i32;
    fd_for_plane = "gbm_bo_get_fd_for_plane": fn(*mut c_void, i32) -> i32;
    stride_for_plane = "gbm_bo_get_stride_for_plane": fn(*mut c_void, i32) -> u32;
    get_offset = "gbm_bo_get_offset": fn(*mut c_void, i32) -> u32;
    get_modifier = "gbm_bo_get_modifier": fn(*mut c_void) -> u64;
    destroy = "gbm_bo_destroy": fn(*mut c_void);
});

functions!(ModifierQuery {
    query = "eglQueryDmaBufModifiersEXT": fn(Display, EglInt, EglInt, *mut u64, *mut EglBool, *mut EglInt) -> EglBool;
});

const XRGB: u32 = super::super::convert::XRGB8888;
const ARGB: u32 = super::super::convert::ARGB8888;

/// A GBM buffer filled through GBM's linear map, exported as dma-bufs.
struct Buffer<'a> {
    bo: &'a GbmBuffers,
    buffer: *mut c_void,
    fds: Vec<OwnedFd>,
    width: u32,
    height: u32,
    format: u32,
    modifier: u64,
}

impl<'a> Buffer<'a> {
    /// `width` × `height` of `format` (with `modifier`, or as the driver
    /// likes), each pixel B, G, R, A from `fill(x, y)`.
    fn new(
        gpu: &Gpu,
        bo: &'a GbmBuffers,
        (width, height, format): (u32, u32, u32),
        modifier: Option<u64>,
        fill: impl Fn(u32, u32) -> [u8; 4],
    ) -> Buffer<'a> {
        const RENDERING: u32 = 1 << 2;
        const TRANSFER_WRITE: u32 = 1 << 1;
        // SAFETY: test-only calls on the GPU's own GBM device; the map is
        // written within stride × height and unmapped before export; the
        // buffer is destroyed once, on drop.
        unsafe {
            let buffer = match modifier {
                Some(m) => (bo.create_with_modifiers)(gpu.device, width, height, format, &m, 1),
                None => (bo.create)(gpu.device, width, height, format, RENDERING),
            };
            assert!(!buffer.is_null(), "GBM allocates with {modifier:x?}");
            let mut stride = 0u32;
            let mut data = std::ptr::null_mut();
            let map = (bo.map)(
                buffer,
                0,
                0,
                width,
                height,
                TRANSFER_WRITE,
                &mut stride,
                &mut data,
            );
            assert!(!map.is_null(), "GBM maps the buffer");
            for y in 0..height {
                for x in 0..width {
                    let pixel = (map as *mut u8).add((y * stride + x * 4) as usize);
                    std::ptr::copy_nonoverlapping(fill(x, y).as_ptr(), pixel, 4);
                }
            }
            (bo.unmap)(buffer, data);
            let count = (bo.plane_count)(buffer);
            let fds = (0..count)
                .map(|plane| {
                    let fd = (bo.fd_for_plane)(buffer, plane);
                    assert!(fd >= 0);
                    OwnedFd::from_raw_fd(fd)
                })
                .collect();
            Buffer {
                bo,
                buffer,
                fds,
                width,
                height,
                format,
                modifier: (bo.get_modifier)(buffer),
            }
        }
    }

    fn planes(&self) -> Vec<DmaPlane<'_>> {
        self.fds
            .iter()
            .enumerate()
            .map(|(plane, fd)| DmaPlane {
                fd: fd.as_fd(),
                // SAFETY: plane indexes below the buffer's plane count.
                offset: unsafe { (self.bo.get_offset)(self.buffer, plane as i32) },
                // SAFETY: as above.
                pitch: unsafe { (self.bo.stride_for_plane)(self.buffer, plane as i32) },
            })
            .collect()
    }

    fn dma<'b>(&self, planes: &'b [DmaPlane<'b>]) -> DmaBuffer<'b> {
        DmaBuffer {
            width: self.width,
            height: self.height,
            format: self.format,
            modifier: self.modifier,
            planes,
        }
    }
}

impl Drop for Buffer<'_> {
    fn drop(&mut self) {
        // SAFETY: the buffer `new` made, destroyed once.
        unsafe { (self.bo.destroy)(self.buffer) };
    }
}

fn layer(src: SourceRect, dst: Rect) -> Layer {
    Layer {
        plane: 1,
        fb_id: 1,
        src,
        dst,
        alpha: OPAQUE,
        blend: Blend::Premultiplied,
        rotation: ROTATE_0,
    }
}

/// Allocates a 300×200 buffer (with `modifier`, or as the driver likes),
/// writes a pattern through GBM's linear map, and reads a crop back as a
/// one-layer composition.
fn round_trip(gpu: &mut Gpu, bo: &GbmBuffers, modifier: Option<u64>) -> u64 {
    // B = x, G = y, R = 0x80.
    let buffer = Buffer::new(gpu, bo, (300, 200, XRGB), modifier, |x, y| {
        [x as u8, y as u8, 0x80, 0xFF]
    });
    let planes = buffer.planes();
    let crop = layer(
        SourceRect::pixels(10, 20, 100, 50),
        Rect::new(0, 0, 100, 50),
    );
    let placement = Placement::new(&crop, 300, 200).unwrap();
    let frame = gpu
        .compose(100, 50, &[(buffer.dma(&planes), placement)])
        .expect("read back");
    assert_eq!((frame.width, frame.height), (100, 50));
    assert_eq!(&frame.row(0)[..4], &[10, 20, 0x80, 0xFF]);
    assert_eq!(&frame.row(49)[99 * 4..], &[109, 69, 0x80, 0xFF]);
    buffer.modifier
}

/// Run by hand on a machine with a GPU render node: buffers laid out as
/// the driver likes and with each tiled modifier it offers for
/// XRGB8888, read back through the EGL path.
#[test]
#[ignore = "needs a GPU render node (/dev/dri/renderD128) and Mesa"]
fn tiled_buffer_reads_back_through_egl() {
    let node =
        std::env::var("BMUSTER_RENDER_NODE").unwrap_or_else(|_| "/dev/dri/renderD128".to_string());
    let mut gpu = Gpu::open(Path::new(&node)).expect("the GPU opens");
    let library = Library::open(LIBRARIES.gbm).unwrap();
    let bo = GbmBuffers::load(&mut |name| library.symbol(name)).unwrap();
    let chosen = round_trip(&mut gpu, &bo, None);
    println!("implicit layout: modifier 0x{chosen:016x}");
    let tiled = tiled_modifiers(&gpu);
    for modifier in &tiled {
        println!("tiled modifier 0x{modifier:016x}");
        round_trip(&mut gpu, &bo, Some(*modifier));
    }
    assert!(!tiled.is_empty(), "the GPU offers a tiled modifier");
}

/// Up to four tiled modifiers the driver offers for XRGB8888.
fn tiled_modifiers(gpu: &Gpu) -> Vec<u64> {
    let query = ModifierQuery::load(&mut |name| {
        // SAFETY: as in `Gpu::open_with`.
        let address = unsafe { (gpu.egl.egl_get_proc_address)(name.as_ptr()) };
        if address.is_null() {
            Err("no modifier query".to_string())
        } else {
            Ok(address)
        }
    })
    .unwrap();
    let mut modifiers = vec![0u64; 64];
    let mut external = vec![0u32; 64];
    let mut count = 0;
    // SAFETY: both buffers hold 64 entries, as the size argument says.
    let ok = unsafe {
        (query.query)(
            gpu.display,
            XRGB as EglInt,
            64,
            modifiers.as_mut_ptr(),
            external.as_mut_ptr(),
            &mut count,
        )
    };
    assert_ne!(ok, 0);
    modifiers
        .into_iter()
        .take(count as usize)
        .filter(|m| *m != super::super::convert::MOD_LINEAR)
        .take(4)
        .collect()
}

/// P6, run by hand on a GPU: a tiled primary that does not cover the CRTC
/// with a scaled, half-transparent overlay hanging off its right edge
/// composes on the GPU exactly as the CPU path draws the same layers.
#[test]
#[ignore = "needs a GPU render node (/dev/dri/renderD128) and Mesa"]
fn planes_compose_through_egl() {
    let node =
        std::env::var("BMUSTER_RENDER_NODE").unwrap_or_else(|_| "/dev/dri/renderD128".to_string());
    let mut gpu = Gpu::open(Path::new(&node)).expect("the GPU opens");
    let library = Library::open(LIBRARIES.gbm).unwrap();
    let bo = GbmBuffers::load(&mut |name| library.symbol(name)).unwrap();
    let mut layouts = vec![None];
    layouts.extend(tiled_modifiers(&gpu).into_iter().map(Some));
    for modifier in layouts {
        compose_two_planes(&mut gpu, &bo, modifier);
    }
}

fn compose_two_planes(gpu: &mut Gpu, bo: &GbmBuffers, modifier: Option<u64>) {
    let pattern = |x: u32, y: u32| [x as u8, y as u8, 0x80, 0xFF];
    let primary = Buffer::new(gpu, bo, (200, 100, XRGB), modifier, pattern);
    // Pre-multiplied half-transparent white.
    let overlay = Buffer::new(gpu, bo, (16, 8, ARGB), None, |_, _| {
        [0x80, 0x80, 0x80, 0x80]
    });
    println!(
        "primary modifier 0x{:016x}, overlay modifier 0x{:016x}",
        primary.modifier, overlay.modifier
    );
    let (width, height) = (240u32, 120u32);
    let bottom = layer(
        SourceRect::pixels(0, 0, 200, 100),
        Rect::new(0, 10, 200, 100),
    );
    let top = layer(SourceRect::pixels(0, 0, 16, 8), Rect::new(180, 0, 96, 48));
    let bottom_placement = Placement::new(&bottom, 200, 100).unwrap();
    let top_placement = Placement::new(&top, 16, 8).unwrap();
    let (primary_planes, overlay_planes) = (primary.planes(), overlay.planes());
    let gpu_frame = gpu
        .compose(
            width,
            height,
            &[
                (primary.dma(&primary_planes), bottom_placement),
                (overlay.dma(&overlay_planes), top_placement),
            ],
        )
        .expect("composes");
    let mut primary_pixels = Frame::new(200, 100);
    for y in 0..100 {
        for x in 0..200 {
            let at = (y * 200 + x) as usize * 4;
            primary_pixels.data[at..at + 4].copy_from_slice(&pattern(x, y));
        }
    }
    let mut overlay_pixels = Frame::new(16, 8);
    for pixel in overlay_pixels.data.chunks_exact_mut(4) {
        pixel.copy_from_slice(&[0x80, 0x80, 0x80, 0x80]);
    }
    let cpu_frame = compose::compose_cpu(
        width,
        height,
        vec![
            CpuLayer {
                placement: bottom_placement,
                pixels: primary_pixels,
                alpha_channel: false,
            },
            CpuLayer {
                placement: top_placement,
                pixels: overlay_pixels,
                alpha_channel: true,
            },
        ],
    );
    let mut worst = 0u8;
    for (g, c) in gpu_frame
        .data
        .chunks_exact(4)
        .zip(cpu_frame.data.chunks_exact(4))
    {
        for channel in 0..3 {
            worst = worst.max(g[channel].abs_diff(c[channel]));
        }
    }
    // Black above the primary, the pattern one to one, the overlay blended.
    assert_eq!(&gpu_frame.row(5)[..4], &[0, 0, 0, 0xFF]);
    assert_eq!(&gpu_frame.row(10)[..4], &[0, 0, 0x80, 0xFF]);
    assert_eq!(&gpu_frame.row(20)[4 * 4..5 * 4], &[4, 10, 0x80, 0xFF]);
    assert_eq!(&gpu_frame.row(60)[230 * 4..231 * 4], &[0, 0, 0, 0xFF]);
    assert!(worst <= 1, "GPU and CPU differ by {worst}");
}
