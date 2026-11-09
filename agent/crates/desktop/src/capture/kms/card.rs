//! One DRM card through raw ioctls from `<drm/drm.h>` and
//! `<drm/drm_mode.h>`: its CRTCs, connectors and planes, framebuffers
//! exported as dma-bufs, and read-only maps of them (SPEC-CONSOLE-CAPTURE,
//! Capture 2–3).
//!
//! Reading resources needs no privilege. Getting a framebuffer's buffer
//! handles (`GETFB2`) needs `CAP_SYS_ADMIN`; without it the kernel returns
//! zero handles and capture says so. Nothing here changes what the screen
//! shows: only `GET*` ioctls are used, and DRM master is dropped at once.
//! The kernel makes the first opener of a card with no master (a text
//! console, or between two compositors) its master, which would stop the
//! next compositor from taking the screen.

use super::convert::{MOD_INVALID, MOD_LINEAR};
use super::egl::DmaPlane;
use super::uapi::*;
use super::{CardResources, Connector, Crtc, Mode, Plane, PlaneKind};
use crate::capture::{CaptureError, CaptureResult};
use crate::ioctl;
use std::collections::HashMap;
use std::fs::File;
use std::io;
use std::os::fd::{AsFd, AsRawFd, BorrowedFd, FromRawFd, OwnedFd};
use std::os::unix::fs::OpenOptionsExt as _;
use std::path::{Path, PathBuf};

/// One open `/dev/dri/card*`.
pub struct Card {
    pub name: String,
    pub path: PathBuf,
    file: File,
    property_names: HashMap<u32, String>,
}

/// A framebuffer's description, without its buffers (for the probe).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FramebufferInfo {
    pub width: u32,
    pub height: u32,
    pub format: u32,
    /// `None` when the framebuffer was made without an explicit modifier.
    pub modifier: Option<u64>,
    pub pitches: Vec<u32>,
    /// False when the kernel withheld the handles (no `CAP_SYS_ADMIN`).
    pub has_handles: bool,
}

/// A framebuffer with its planes exported as dma-bufs.
pub struct Framebuffer {
    pub info: FramebufferInfo,
    pub(super) planes: Vec<(OwnedFd, u32, u32)>,
}

impl Framebuffer {
    /// True when the CPU can read it directly: linear, or no modifier.
    pub(super) fn linear(&self) -> bool {
        matches!(self.info.modifier, None | Some(MOD_LINEAR))
    }

    pub(super) fn dma(&self) -> Vec<DmaPlane<'_>> {
        self.planes
            .iter()
            .map(|(fd, offset, pitch)| DmaPlane {
                fd: fd.as_fd(),
                offset: *offset,
                pitch: *pitch,
            })
            .collect()
    }
}

impl Card {
    /// Opens a card read-write (KMS ioctls need it; nothing is changed),
    /// gives up master if the kernel handed it over, and asks for every
    /// plane and the atomic properties (cursor position).
    pub fn open(path: &Path) -> io::Result<Card> {
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(libc::O_CLOEXEC)
            .open(path)?;
        // SAFETY: DROP_MASTER takes no argument. It fails (EINVAL) when this
        // descriptor is not master, which is the usual case and harmless.
        let _ = unsafe { ioctl::call(file.as_fd(), DROP_MASTER, 0) };
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let card = Card {
            name,
            path: path.to_path_buf(),
            file,
            property_names: HashMap::new(),
        };
        for capability in [CLIENT_CAP_UNIVERSAL_PLANES, CLIENT_CAP_ATOMIC] {
            let mut cap = ClientCap {
                capability,
                value: 1,
            };
            // SAFETY: SET_CLIENT_CAP takes a drm_set_client_cap.
            // Drivers without atomic refuse the second; planes still list.
            let _ = unsafe { ioctl::call_with(card.fd(), SET_CLIENT_CAP, &mut cap) };
        }
        Ok(card)
    }

    fn fd(&self) -> BorrowedFd<'_> {
        self.file.as_fd()
    }

    /// Reads CRTCs, connectors and planes.
    pub fn resources(&mut self) -> io::Result<CardResources> {
        let (crtc_ids, connector_ids) = self.ids()?;
        let mut crtcs = Vec::new();
        for id in crtc_ids {
            crtcs.push(self.crtc(id)?);
        }
        let mut connectors = Vec::new();
        for id in connector_ids {
            match self.connector(id) {
                Ok(connector) => connectors.push(connector),
                // Unplugged between the two calls (MST): skip it.
                Err(error) if error.raw_os_error() == Some(libc::ENOENT) => {}
                Err(error) => return Err(error),
            }
        }
        let mut planes = Vec::new();
        for id in self.plane_ids()? {
            planes.push(self.plane(id)?);
        }
        Ok(CardResources {
            card: self.name.clone(),
            crtcs,
            connectors,
            planes,
        })
    }

    fn ids(&self) -> io::Result<(Vec<u32>, Vec<u32>)> {
        loop {
            let mut counts = CardRes::default();
            // SAFETY: GETRESOURCES with every pointer null only fills counts.
            unsafe { ioctl::call_with(self.fd(), GETRESOURCES, &mut counts) }?;
            let mut crtcs = vec![0u32; counts.count_crtcs as usize];
            let mut connectors = vec![0u32; counts.count_connectors as usize];
            let mut encoders = vec![0u32; counts.count_encoders as usize];
            let mut fbs = vec![0u32; counts.count_fbs as usize];
            let mut full = CardRes {
                fb_id_ptr: pointer(&mut fbs),
                crtc_id_ptr: pointer(&mut crtcs),
                connector_id_ptr: pointer(&mut connectors),
                encoder_id_ptr: pointer(&mut encoders),
                count_fbs: counts.count_fbs,
                count_crtcs: counts.count_crtcs,
                count_connectors: counts.count_connectors,
                count_encoders: counts.count_encoders,
                ..CardRes::default()
            };
            // SAFETY: each pointer is a buffer of exactly the count beside it.
            unsafe { ioctl::call_with(self.fd(), GETRESOURCES, &mut full) }?;
            // A connector appeared between the calls: the kernel copied
            // nothing for the grown list, so ask again.
            if full.count_crtcs as usize > crtcs.len()
                || full.count_connectors as usize > connectors.len()
                || full.count_encoders as usize > encoders.len()
                || full.count_fbs as usize > fbs.len()
            {
                continue;
            }
            crtcs.truncate(full.count_crtcs as usize);
            connectors.truncate(full.count_connectors as usize);
            return Ok((crtcs, connectors));
        }
    }

    /// One CRTC now: its mode and the framebuffer it scans out.
    pub fn crtc(&self, id: u32) -> io::Result<Crtc> {
        let mut raw = CrtcRaw {
            crtc_id: id,
            ..CrtcRaw::default()
        };
        // SAFETY: GETCRTC with no connector list fills the struct only.
        unsafe { ioctl::call_with(self.fd(), GETCRTC, &mut raw) }?;
        Ok(Crtc {
            id,
            fb_id: raw.fb_id,
            x: raw.x,
            y: raw.y,
            mode: (raw.mode_valid != 0).then(|| Mode {
                width: u32::from(raw.mode.hdisplay),
                height: u32::from(raw.mode.vdisplay),
                refresh: raw.mode.vrefresh,
            }),
        })
    }

    fn connector(&self, id: u32) -> io::Result<Connector> {
        let mut raw = ConnectorRaw {
            connector_id: id,
            ..ConnectorRaw::default()
        };
        // SAFETY: all counts are 0 and pointers null, so the kernel copies no
        // arrays; with count_modes 0 a client that is not master never
        // triggers a probe.
        unsafe { ioctl::call_with(self.fd(), GETCONNECTOR, &mut raw) }?;
        let kind = CONNECTOR_TYPES
            .get(raw.connector_type as usize)
            .copied()
            .unwrap_or("Unknown");
        let crtc_id = if raw.encoder_id == 0 {
            None
        } else {
            let mut encoder = EncoderRaw {
                encoder_id: raw.encoder_id,
                ..EncoderRaw::default()
            };
            // SAFETY: GETENCODER takes and fills a drm_mode_get_encoder.
            unsafe { ioctl::call_with(self.fd(), GETENCODER, &mut encoder) }?;
            (encoder.crtc_id != 0).then_some(encoder.crtc_id)
        };
        Ok(Connector {
            id,
            name: format!("{kind}-{}", raw.connector_type_id),
            connected: raw.connection == CONNECTED,
            crtc_id,
        })
    }

    pub(super) fn plane_ids(&self) -> io::Result<Vec<u32>> {
        loop {
            let mut counts = PlaneRes::default();
            // SAFETY: a null pointer with count 0 only fills the count.
            unsafe { ioctl::call_with(self.fd(), GETPLANERESOURCES, &mut counts) }?;
            let mut ids = vec![0u32; counts.count_planes as usize];
            let mut full = PlaneRes {
                plane_id_ptr: pointer(&mut ids),
                count_planes: counts.count_planes,
            };
            // SAFETY: the pointer is a buffer of `count_planes` ids.
            unsafe { ioctl::call_with(self.fd(), GETPLANERESOURCES, &mut full) }?;
            if full.count_planes as usize > ids.len() {
                continue;
            }
            ids.truncate(full.count_planes as usize);
            return Ok(ids);
        }
    }

    /// One plane now, with its type and position from its properties.
    pub fn plane(&mut self, id: u32) -> io::Result<Plane> {
        let mut raw = PlaneRaw {
            plane_id: id,
            ..PlaneRaw::default()
        };
        // SAFETY: count_format_types is 0, so no format list is copied.
        unsafe { ioctl::call_with(self.fd(), GETPLANE, &mut raw) }?;
        let properties = self.properties(id, OBJECT_PLANE)?;
        let get = |name: &str| properties.iter().find(|(n, _)| n == name).map(|(_, v)| *v);
        let kind = match get("type") {
            Some(1) => PlaneKind::Primary,
            Some(2) => PlaneKind::Cursor,
            _ => PlaneKind::Overlay,
        };
        // CRTC_X and CRTC_Y are signed (the cursor can hang off the edge).
        let signed = |name: &str| get(name).map_or(0, |v| v as i64 as i32);
        Ok(Plane {
            id,
            kind,
            crtc_id: raw.crtc_id,
            fb_id: raw.fb_id,
            crtc_x: signed("CRTC_X"),
            crtc_y: signed("CRTC_Y"),
        })
    }

    /// An object's properties by name.
    fn properties(&mut self, object: u32, kind: u32) -> io::Result<Vec<(String, u64)>> {
        let (ids, values) = loop {
            let mut counts = ObjProps {
                obj_id: object,
                obj_type: kind,
                ..ObjProps::default()
            };
            // SAFETY: null pointers with count 0 only fill the count.
            unsafe { ioctl::call_with(self.fd(), OBJ_GETPROPERTIES, &mut counts) }?;
            let mut ids = vec![0u32; counts.count_props as usize];
            let mut values = vec![0u64; counts.count_props as usize];
            let mut full = ObjProps {
                props_ptr: pointer(&mut ids),
                prop_values_ptr: pointer(&mut values),
                count_props: counts.count_props,
                obj_id: object,
                obj_type: kind,
            };
            // SAFETY: both buffers hold `count_props` entries.
            unsafe { ioctl::call_with(self.fd(), OBJ_GETPROPERTIES, &mut full) }?;
            if full.count_props as usize > ids.len() {
                continue;
            }
            ids.truncate(full.count_props as usize);
            values.truncate(full.count_props as usize);
            break (ids, values);
        };
        let mut named = Vec::with_capacity(ids.len());
        for (id, value) in ids.into_iter().zip(values) {
            named.push((self.property_name(id)?, value));
        }
        Ok(named)
    }

    fn property_name(&mut self, id: u32) -> io::Result<String> {
        if let Some(name) = self.property_names.get(&id) {
            return Ok(name.clone());
        }
        let mut raw = GetProperty {
            prop_id: id,
            ..GetProperty::default()
        };
        // SAFETY: counts are 0 and pointers null, so only the name and
        // flags are filled.
        unsafe { ioctl::call_with(self.fd(), GETPROPERTY, &mut raw) }?;
        let end = raw.name.iter().position(|&b| b == 0).unwrap_or(32);
        let name = String::from_utf8_lossy(&raw.name[..end]).into_owned();
        self.property_names.insert(id, name.clone());
        Ok(name)
    }

    fn getfb2(&self, fb_id: u32) -> io::Result<Fb2> {
        let mut raw = Fb2 {
            fb_id,
            ..Fb2::default()
        };
        // SAFETY: GETFB2 takes and fills a drm_mode_fb_cmd2.
        unsafe { ioctl::call_with(self.fd(), GETFB2, &mut raw) }?;
        Ok(raw)
    }

    /// A framebuffer's description.
    pub fn framebuffer_info(&self, fb_id: u32) -> io::Result<FramebufferInfo> {
        let raw = self.getfb2(fb_id)?;
        let info = info_of(&raw);
        self.close_handles(&raw);
        Ok(info)
    }

    /// A framebuffer with every plane exported as a dma-buf. The GEM handles
    /// `GETFB2` made are closed again before returning.
    pub fn framebuffer(&self, fb_id: u32) -> CaptureResult<Framebuffer> {
        let raw = self
            .getfb2(fb_id)
            .map_err(|e| CaptureError::new(format!("Cannot read framebuffer {fb_id}: {e}")))?;
        let info = info_of(&raw);
        if !info.has_handles {
            self.close_handles(&raw);
            return Err(CaptureError::new(
                "Reading the screen needs root (CAP_SYS_ADMIN): the kernel withheld the framebuffer",
            ));
        }
        let mut planes = Vec::new();
        let mut exported: Vec<(u32, OwnedFd)> = Vec::new();
        let mut result = Ok(());
        for index in 0..plane_count(&raw) {
            let handle = raw.handles[index];
            let fd = match exported.iter().find(|(h, _)| *h == handle) {
                Some((_, fd)) => fd.try_clone(),
                None => self.export(handle).and_then(|fd| {
                    let copy = fd.try_clone();
                    exported.push((handle, fd));
                    copy
                }),
            };
            match fd {
                Ok(fd) => planes.push((fd, raw.offsets[index], raw.pitches[index])),
                Err(error) => {
                    result = Err(CaptureError::new(format!(
                        "Cannot export framebuffer {fb_id} as a dma-buf: {error}"
                    )));
                    break;
                }
            }
        }
        self.close_handles(&raw);
        result.map(|()| Framebuffer { info, planes })
    }

    fn export(&self, handle: u32) -> io::Result<OwnedFd> {
        let mut prime = PrimeHandle {
            handle,
            flags: libc::O_CLOEXEC as u32 | libc::O_RDWR as u32,
            fd: -1,
        };
        // SAFETY: PRIME_HANDLE_TO_FD takes and fills a drm_prime_handle.
        let result = unsafe { ioctl::call_with(self.fd(), PRIME_HANDLE_TO_FD, &mut prime) };
        if result.is_err() {
            // Some drivers refuse a writable export; read-only is enough.
            prime.flags = libc::O_CLOEXEC as u32;
            // SAFETY: as above.
            unsafe { ioctl::call_with(self.fd(), PRIME_HANDLE_TO_FD, &mut prime) }?;
        }
        if prime.fd < 0 {
            return Err(io::Error::other("the kernel returned no dma-buf"));
        }
        // SAFETY: the kernel just created this descriptor for us; nothing
        // else owns it.
        Ok(unsafe { OwnedFd::from_raw_fd(prime.fd) })
    }

    /// Closes each distinct GEM handle `GETFB2` created, once.
    fn close_handles(&self, raw: &Fb2) {
        let mut closed: Vec<u32> = Vec::new();
        for &handle in &raw.handles {
            if handle == 0 || closed.contains(&handle) {
                continue;
            }
            closed.push(handle);
            let mut close = GemClose { handle, pad: 0 };
            // SAFETY: GEM_CLOSE takes a drm_gem_close.
            let _ = unsafe { ioctl::call_with(self.fd(), GEM_CLOSE, &mut close) };
        }
    }

    /// The render node of the same GPU (`/dev/dri/renderD*`), for EGL.
    pub fn render_node(&self) -> Option<PathBuf> {
        let dir = Path::new("/sys/class/drm")
            .join(&self.name)
            .join("device/drm");
        std::fs::read_dir(dir).ok()?.flatten().find_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            name.starts_with("renderD")
                .then(|| Path::new("/dev/dri").join(name))
        })
    }
}

fn plane_count(raw: &Fb2) -> usize {
    raw.handles.iter().take_while(|&&h| h != 0).count().max(1)
}

fn info_of(raw: &Fb2) -> FramebufferInfo {
    let planes = raw.pitches.iter().take_while(|&&p| p != 0).count().max(1);
    FramebufferInfo {
        width: raw.width,
        height: raw.height,
        format: raw.pixel_format,
        modifier: (raw.flags & FB_MODIFIERS != 0 && raw.modifier[0] != MOD_INVALID)
            .then_some(raw.modifier[0]),
        pitches: raw.pitches[..planes].to_vec(),
        has_handles: raw.handles[0] != 0,
    }
}

/// A read-only map of a dma-buf, bracketed by `DMA_BUF_IOCTL_SYNC`.
pub(super) struct Mapping<'a> {
    fd: BorrowedFd<'a>,
    address: *mut libc::c_void,
    length: usize,
}

impl<'a> Mapping<'a> {
    pub(super) fn new(fd: BorrowedFd<'a>) -> io::Result<Mapping<'a>> {
        // SAFETY: lseek on an open descriptor; a dma-buf reports its size.
        let size = unsafe { libc::lseek(fd.as_raw_fd(), 0, libc::SEEK_END) };
        if size <= 0 {
            return Err(io::Error::other("the dma-buf has no size"));
        }
        let length = size as usize;
        // SAFETY: a fresh read-only shared mapping of `length` bytes of the
        // dma-buf; the kernel picks the address.
        let address = unsafe {
            libc::mmap(
                std::ptr::null_mut(),
                length,
                libc::PROT_READ,
                libc::MAP_SHARED,
                fd.as_raw_fd(),
                0,
            )
        };
        if address == libc::MAP_FAILED {
            return Err(io::Error::last_os_error());
        }
        let mapping = Mapping {
            fd,
            address,
            length,
        };
        mapping.sync(DMA_BUF_SYNC_READ)?;
        Ok(mapping)
    }

    fn sync(&self, flags: u64) -> io::Result<()> {
        let mut sync = DmaBufSync { flags };
        // SAFETY: DMA_BUF_IOCTL_SYNC takes a dma_buf_sync.
        unsafe { ioctl::call_with(self.fd, DMA_BUF_IOCTL_SYNC, &mut sync) }.map(|_| ())
    }

    pub(super) fn bytes(&self) -> &[u8] {
        // SAFETY: `address` is a live mapping of `length` readable bytes
        // until drop; the slice borrows `self`, so it cannot outlive it.
        unsafe { std::slice::from_raw_parts(self.address as *const u8, self.length) }
    }
}

impl Drop for Mapping<'_> {
    fn drop(&mut self) {
        let _ = self.sync(DMA_BUF_SYNC_READ | DMA_BUF_SYNC_END);
        // SAFETY: unmaps exactly the mapping `new` made; no slice of it
        // outlives `self`.
        unsafe { libc::munmap(self.address, self.length) };
    }
}

/// Every `/dev/dri/card*`, sorted.
pub fn card_paths() -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = std::fs::read_dir("/dev/dri")
        .map(|entries| {
            entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| {
                    p.file_name()
                        .is_some_and(|n| n.to_string_lossy().starts_with("card"))
                })
                .collect()
        })
        .unwrap_or_default();
    paths.sort();
    paths
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn framebuffer_description() {
        let mut raw = Fb2 {
            width: 64,
            height: 64,
            pixel_format: super::super::convert::ARGB8888,
            flags: FB_MODIFIERS,
            ..Fb2::default()
        };
        raw.handles[0] = 7;
        raw.pitches[0] = 256;
        raw.modifier[0] = 0x0200_0000_0000_0001;
        let info = info_of(&raw);
        assert_eq!(info.modifier, Some(0x0200_0000_0000_0001));
        assert_eq!(info.pitches, vec![256]);
        assert!(info.has_handles);
        raw.flags = 0;
        raw.handles[0] = 0;
        let info = info_of(&raw);
        assert_eq!(info.modifier, None, "no modifier flag");
        assert!(!info.has_handles, "the kernel withheld the handles");
    }
}
