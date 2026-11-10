//! The DRM and dma-buf uAPI as `<drm/drm.h>`, `<drm/drm_mode.h>` and
//! `<linux/dma-buf.h>` declare it: argument structs, request numbers and
//! flags. Checked against the C headers in the tests.

use crate::ioctl;

#[repr(C)]
#[derive(Default)]
pub(super) struct CardRes {
    pub(super) fb_id_ptr: u64,
    pub(super) crtc_id_ptr: u64,
    pub(super) connector_id_ptr: u64,
    pub(super) encoder_id_ptr: u64,
    pub(super) count_fbs: u32,
    pub(super) count_crtcs: u32,
    pub(super) count_connectors: u32,
    pub(super) count_encoders: u32,
    pub(super) min_width: u32,
    pub(super) max_width: u32,
    pub(super) min_height: u32,
    pub(super) max_height: u32,
}

#[repr(C)]
#[derive(Default)]
pub(super) struct ModeInfo {
    pub(super) clock: u32,
    pub(super) hdisplay: u16,
    pub(super) hsync_start: u16,
    pub(super) hsync_end: u16,
    pub(super) htotal: u16,
    pub(super) hskew: u16,
    pub(super) vdisplay: u16,
    pub(super) vsync_start: u16,
    pub(super) vsync_end: u16,
    pub(super) vtotal: u16,
    pub(super) vscan: u16,
    pub(super) vrefresh: u32,
    pub(super) flags: u32,
    pub(super) kind: u32,
    pub(super) name: [u8; 32],
}

#[repr(C)]
#[derive(Default)]
pub(super) struct CrtcRaw {
    pub(super) set_connectors_ptr: u64,
    pub(super) count_connectors: u32,
    pub(super) crtc_id: u32,
    pub(super) fb_id: u32,
    pub(super) x: u32,
    pub(super) y: u32,
    pub(super) gamma_size: u32,
    pub(super) mode_valid: u32,
    pub(super) mode: ModeInfo,
}

#[repr(C)]
#[derive(Default)]
pub(super) struct ConnectorRaw {
    pub(super) encoders_ptr: u64,
    pub(super) modes_ptr: u64,
    pub(super) props_ptr: u64,
    pub(super) prop_values_ptr: u64,
    pub(super) count_modes: u32,
    pub(super) count_props: u32,
    pub(super) count_encoders: u32,
    pub(super) encoder_id: u32,
    pub(super) connector_id: u32,
    pub(super) connector_type: u32,
    pub(super) connector_type_id: u32,
    pub(super) connection: u32,
    pub(super) mm_width: u32,
    pub(super) mm_height: u32,
    pub(super) subpixel: u32,
    pub(super) pad: u32,
}

#[repr(C)]
#[derive(Default)]
pub(super) struct EncoderRaw {
    pub(super) encoder_id: u32,
    pub(super) encoder_type: u32,
    pub(super) crtc_id: u32,
    pub(super) possible_crtcs: u32,
    pub(super) possible_clones: u32,
}

#[repr(C)]
#[derive(Default)]
pub(super) struct PlaneRes {
    pub(super) plane_id_ptr: u64,
    pub(super) count_planes: u32,
}

#[repr(C)]
#[derive(Default)]
pub(super) struct PlaneRaw {
    pub(super) plane_id: u32,
    pub(super) crtc_id: u32,
    pub(super) fb_id: u32,
    pub(super) possible_crtcs: u32,
    pub(super) gamma_size: u32,
    pub(super) count_format_types: u32,
    pub(super) format_type_ptr: u64,
}

#[repr(C)]
#[derive(Default)]
pub(super) struct Fb2 {
    pub(super) fb_id: u32,
    pub(super) width: u32,
    pub(super) height: u32,
    pub(super) pixel_format: u32,
    pub(super) flags: u32,
    pub(super) handles: [u32; 4],
    pub(super) pitches: [u32; 4],
    pub(super) offsets: [u32; 4],
    pub(super) modifier: [u64; 4],
}

#[repr(C)]
#[derive(Default)]
pub(super) struct PrimeHandle {
    pub(super) handle: u32,
    pub(super) flags: u32,
    pub(super) fd: i32,
}

#[repr(C)]
#[derive(Default)]
pub(super) struct GemClose {
    pub(super) handle: u32,
    pub(super) pad: u32,
}

#[repr(C)]
#[derive(Default)]
pub(super) struct ClientCap {
    pub(super) capability: u64,
    pub(super) value: u64,
}

#[repr(C)]
#[derive(Default)]
pub(super) struct ObjProps {
    pub(super) props_ptr: u64,
    pub(super) prop_values_ptr: u64,
    pub(super) count_props: u32,
    pub(super) obj_id: u32,
    pub(super) obj_type: u32,
}

#[repr(C)]
#[derive(Default)]
pub(super) struct GetProperty {
    pub(super) values_ptr: u64,
    pub(super) enum_blob_ptr: u64,
    pub(super) prop_id: u32,
    pub(super) flags: u32,
    pub(super) name: [u8; 32],
    pub(super) count_values: u32,
    pub(super) count_enum_blobs: u32,
}

/// `drm_mode_property_enum`: one value of an enum property and its name.
#[repr(C)]
#[derive(Default)]
pub(super) struct PropertyEnum {
    pub(super) value: u64,
    pub(super) name: [u8; 32],
}

#[repr(C)]
pub(super) struct DmaBufSync {
    pub(super) flags: u64,
}

pub(super) const D: u8 = b'd';
pub(super) const GETRESOURCES: u64 = ioctl::iowr::<CardRes>(D, 0xA0);
pub(super) const GETCRTC: u64 = ioctl::iowr::<CrtcRaw>(D, 0xA1);
pub(super) const GETENCODER: u64 = ioctl::iowr::<EncoderRaw>(D, 0xA6);
pub(super) const GETCONNECTOR: u64 = ioctl::iowr::<ConnectorRaw>(D, 0xA7);
pub(super) const GETPROPERTY: u64 = ioctl::iowr::<GetProperty>(D, 0xAA);
pub(super) const GETPLANERESOURCES: u64 = ioctl::iowr::<PlaneRes>(D, 0xB5);
pub(super) const GETPLANE: u64 = ioctl::iowr::<PlaneRaw>(D, 0xB6);
pub(super) const OBJ_GETPROPERTIES: u64 = ioctl::iowr::<ObjProps>(D, 0xB9);
pub(super) const GETFB2: u64 = ioctl::iowr::<Fb2>(D, 0xCE);
pub(super) const PRIME_HANDLE_TO_FD: u64 = ioctl::iowr::<PrimeHandle>(D, 0x2D);
pub(super) const GEM_CLOSE: u64 = ioctl::iow::<GemClose>(D, 0x09);
pub(super) const SET_CLIENT_CAP: u64 = ioctl::iow::<ClientCap>(D, 0x0D);
pub(super) const DROP_MASTER: u64 = ioctl::io(D, 0x1F);
pub(super) const DMA_BUF_IOCTL_SYNC: u64 = ioctl::iow::<DmaBufSync>(b'b', 0);

pub(super) const CLIENT_CAP_UNIVERSAL_PLANES: u64 = 2;
pub(super) const CLIENT_CAP_ATOMIC: u64 = 3;
pub(super) const OBJECT_PLANE: u32 = 0xeeee_eeee;
pub(super) const CONNECTED: u32 = 1;
pub(super) const FB_MODIFIERS: u32 = 1 << 1;
pub(super) const DMA_BUF_SYNC_READ: u64 = 1;
pub(super) const DMA_BUF_SYNC_END: u64 = 1 << 2;

/// Connector type names as the kernel spells them (`drm_connector.c`).
pub(super) const CONNECTOR_TYPES: [&str; 21] = [
    "Unknown",
    "VGA",
    "DVI-I",
    "DVI-D",
    "DVI-A",
    "Composite",
    "SVIDEO",
    "LVDS",
    "Component",
    "DIN",
    "DP",
    "HDMI-A",
    "HDMI-B",
    "TV",
    "eDP",
    "Virtual",
    "DSI",
    "DPI",
    "Writeback",
    "SPI",
    "USB",
];

/// A pointer to `values` for an ioctl's `*_ptr` field.
pub(super) fn pointer<T>(values: &mut [T]) -> u64 {
    values.as_mut_ptr() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ioctl_numbers_and_struct_sizes_match_the_kernel_headers() {
        // Printed by a C program against <drm/drm.h>, <drm/drm_mode.h> and
        // <linux/dma-buf.h> on Linux 7.0 (x86_64).
        assert_eq!(GETRESOURCES, 0xc040_64a0);
        assert_eq!(GETCRTC, 0xc068_64a1);
        assert_eq!(GETCONNECTOR, 0xc050_64a7);
        assert_eq!(GETENCODER, 0xc014_64a6);
        assert_eq!(GETPLANERESOURCES, 0xc010_64b5);
        assert_eq!(GETPLANE, 0xc020_64b6);
        assert_eq!(GETFB2, 0xc068_64ce);
        assert_eq!(PRIME_HANDLE_TO_FD, 0xc00c_642d);
        assert_eq!(GEM_CLOSE, 0x4008_6409);
        assert_eq!(SET_CLIENT_CAP, 0x4010_640d);
        assert_eq!(DROP_MASTER, 0x641f);
        assert_eq!(OBJ_GETPROPERTIES, 0xc020_64b9);
        assert_eq!(GETPROPERTY, 0xc040_64aa);
        assert_eq!(DMA_BUF_IOCTL_SYNC, 0x4008_6200);
        assert_eq!(std::mem::size_of::<PropertyEnum>(), 40);
    }
}
