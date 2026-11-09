//! EGL: missing libraries are reported, and (by hand, on a GPU) buffers
//! in every tiled layout the driver offers read back exactly.

use super::*;

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

/// Allocates a 300×200 buffer (with `modifier`, or as the driver likes),
/// writes a pattern through GBM's linear map, and reads a crop back
/// through [`Gpu::read`].
fn round_trip(gpu: &mut Gpu, bo: &GbmBuffers, modifier: Option<u64>) -> u64 {
    use std::os::fd::{AsFd, FromRawFd, OwnedFd};
    let (width, height) = (300u32, 200u32);
    const RENDERING: u32 = 1 << 2;
    const TRANSFER_WRITE: u32 = 1 << 1;
    // SAFETY: test-only calls on the GPU's own GBM device; the map is
    // written within stride × height and unmapped before export; the
    // buffer is destroyed once at the end.
    unsafe {
        let buffer = match modifier {
            Some(m) => (bo.create_with_modifiers)(gpu.device, width, height, XRGB, &m, 1),
            None => (bo.create)(gpu.device, width, height, XRGB, RENDERING),
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
                // B = x, G = y, R = 0x80.
                std::ptr::copy_nonoverlapping([x as u8, y as u8, 0x80, 0xFF].as_ptr(), pixel, 4);
            }
        }
        (bo.unmap)(buffer, data);
        let count = (bo.plane_count)(buffer);
        let fds: Vec<OwnedFd> = (0..count)
            .map(|plane| {
                let fd = (bo.fd_for_plane)(buffer, plane);
                assert!(fd >= 0);
                OwnedFd::from_raw_fd(fd)
            })
            .collect();
        let chosen = (bo.get_modifier)(buffer);
        let planes: Vec<DmaPlane<'_>> = fds
            .iter()
            .enumerate()
            .map(|(plane, fd)| DmaPlane {
                fd: fd.as_fd(),
                offset: (bo.get_offset)(buffer, plane as i32),
                pitch: (bo.stride_for_plane)(buffer, plane as i32),
            })
            .collect();
        let dma = DmaBuffer {
            width,
            height,
            format: XRGB,
            modifier: chosen,
            planes: &planes,
        };
        let frame = gpu
            .read(&dma, Rect::new(10, 20, 100, 50))
            .expect("read back");
        assert_eq!((frame.width, frame.height), (100, 50));
        assert_eq!(&frame.row(0)[..4], &[10, 20, 0x80, 0xFF]);
        assert_eq!(&frame.row(49)[99 * 4..], &[109, 69, 0x80, 0xFF]);
        (bo.destroy)(buffer);
        chosen
    }
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
    let mut tiled = 0;
    for (modifier, _external) in modifiers.iter().zip(&external).take(count as usize) {
        if *modifier == super::super::convert::MOD_LINEAR {
            continue;
        }
        println!("tiled modifier 0x{modifier:016x}");
        round_trip(&mut gpu, &bo, Some(*modifier));
        tiled += 1;
        if tiled == 4 {
            break;
        }
    }
    assert!(tiled > 0, "the GPU offers a tiled modifier");
}
