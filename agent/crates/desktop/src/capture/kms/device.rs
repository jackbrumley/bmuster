//! [`KmsReader`]: every card's screens as one [`KmsSource`], which the root
//! `console-helper` serves (SPEC-CONSOLE-CAPTURE, Capture 2–4). The cards
//! themselves are in [`super::card`].

use super::card::{card_paths, Card, Framebuffer, Mapping};
use super::convert::{self, BufferLayout, MOD_INVALID};
use super::egl::{DmaBuffer, Gpu};
use super::{displays_from_resources, KmsCursor, KmsDisplay, KmsSource, Plane, PlaneKind};
use crate::capture::{CaptureError, CaptureResult, CursorImage, Frame, Rect};
use std::collections::HashMap;
use std::os::fd::AsFd;
use std::path::Path;

/// Why there is no KMS at all, in words an admin can act on.
fn no_kms_reason() -> String {
    let nvidia_modeset = std::fs::read_to_string("/sys/module/nvidia_drm/parameters/modeset");
    match nvidia_modeset {
        Ok(value) if value.trim() != "Y" => "The NVIDIA driver is loaded without kernel mode setting; set nvidia-drm.modeset=1 to show this screen".to_string(),
        _ if Path::new("/proc/driver/nvidia").exists() && !Path::new("/sys/module/nvidia_drm").exists() => {
            "The NVIDIA driver is loaded without nvidia-drm; load it with modeset=1 to show this screen".to_string()
        }
        _ => "This machine has no graphics card with kernel mode setting (/dev/dri/card*)".to_string(),
    }
}

struct LastCursor {
    shape: u32,
    image: CursorImage,
}

/// KMS capture over every card: the helper's [`KmsSource`].
pub struct KmsReader {
    cards: Vec<Card>,
    displays: Vec<KmsDisplay>,
    /// The last image sent per display, to answer "unchanged".
    last: HashMap<String, Frame>,
    /// One GPU context per card, made on the first tiled buffer.
    gpus: HashMap<String, Result<Gpu, String>>,
    cursors: Vec<LastCursor>,
}

impl KmsReader {
    /// Opens every card that has KMS (render-only GPUs are skipped).
    pub fn open() -> CaptureResult<KmsReader> {
        let mut cards = Vec::new();
        let mut errors = Vec::new();
        for path in card_paths() {
            match Card::open(&path) {
                Ok(mut card) => match card.resources() {
                    Ok(_) => cards.push(card),
                    Err(error) => errors.push(format!("{}: {error}", path.display())),
                },
                Err(error) => errors.push(format!("{}: {error}", path.display())),
            }
        }
        if cards.is_empty() {
            let mut reason = no_kms_reason();
            if !errors.is_empty() {
                reason = format!("{reason} ({})", errors.join("; "));
            }
            return Err(CaptureError::new(reason));
        }
        Ok(KmsReader {
            cards,
            displays: Vec::new(),
            last: HashMap::new(),
            gpus: HashMap::new(),
            cursors: Vec::new(),
        })
    }

    pub fn cards(&mut self) -> &mut [Card] {
        &mut self.cards
    }

    fn card(&self, name: &str) -> CaptureResult<&Card> {
        self.cards
            .iter()
            .find(|c| c.name == name)
            .ok_or_else(|| CaptureError::new(format!("The graphics card {name} went away")))
    }

    fn display(&mut self, id: &str) -> CaptureResult<KmsDisplay> {
        if let Some(display) = self.displays.iter().find(|d| d.id == id) {
            return Ok(display.clone());
        }
        self.displays()?;
        self.displays
            .iter()
            .find(|d| d.id == id)
            .cloned()
            .ok_or_else(|| CaptureError::new(format!("The display {id} is off")))
    }

    /// Reads `crop` of a framebuffer: mapped when linear, through the GPU
    /// otherwise.
    fn read(&mut self, card: &str, fb: &Framebuffer, crop: Rect) -> CaptureResult<Frame> {
        if fb.linear() && convert::bytes_per_pixel(fb.info.format).is_some() {
            let (fd, offset, pitch) = &fb.planes[0];
            let mapping = Mapping::new(fd.as_fd())
                .map_err(|e| CaptureError::new(format!("Cannot map the framebuffer: {e}")))?;
            let layout = BufferLayout {
                format: fb.info.format,
                pitch: *pitch,
                offset: *offset,
                width: fb.info.width,
                height: fb.info.height,
            };
            return convert::convert(mapping.bytes(), &layout, crop).map_err(CaptureError::new);
        }
        let render_node = self.card(card)?.render_node();
        let gpu = self
            .gpus
            .entry(card.to_string())
            .or_insert_with(|| match render_node {
                Some(node) => Gpu::open(&node),
                None => Err(format!("{card} has no render node for EGL")),
            });
        let gpu = gpu.as_mut().map_err(|e| {
            CaptureError::new(format!(
                "The screen uses a tiled buffer and EGL is not available: {e}"
            ))
        })?;
        let planes = fb.dma();
        gpu.read(
            &DmaBuffer {
                width: fb.info.width,
                height: fb.info.height,
                format: fb.info.format,
                modifier: fb.info.modifier.unwrap_or(MOD_INVALID),
                planes: &planes,
            },
            crop,
        )
        .map_err(CaptureError::new)
    }

    fn cursor_plane(&mut self, display: &KmsDisplay) -> CaptureResult<Option<Plane>> {
        let card = self
            .cards
            .iter_mut()
            .find(|c| c.name == display.card)
            .ok_or_else(|| {
                CaptureError::new(format!("The graphics card {} went away", display.card))
            })?;
        for id in card
            .plane_ids()
            .map_err(|e| CaptureError::new(format!("Cannot list planes: {e}")))?
        {
            let plane = card
                .plane(id)
                .map_err(|e| CaptureError::new(format!("Cannot read plane {id}: {e}")))?;
            if plane.kind == PlaneKind::Cursor && plane.crtc_id == display.crtc_id {
                return Ok(Some(plane));
            }
        }
        Ok(None)
    }
}

impl KmsSource for KmsReader {
    fn displays(&mut self) -> CaptureResult<Vec<KmsDisplay>> {
        let mut all = Vec::new();
        for card in &mut self.cards {
            all.push(card.resources().map_err(|e| {
                CaptureError::new(format!("Cannot read {}: {e}", card.path.display()))
            })?);
        }
        self.displays = displays_from_resources(&all);
        self.last
            .retain(|id, _| self.displays.iter().any(|d| &d.id == id));
        Ok(self.displays.clone())
    }

    fn capture(&mut self, id: &str, full: bool) -> CaptureResult<Option<Frame>> {
        let display = self.display(id)?;
        let crtc = self
            .card(&display.card)?
            .crtc(display.crtc_id)
            .map_err(|e| CaptureError::new(format!("Cannot read CRTC {}: {e}", display.crtc_id)))?;
        if crtc.fb_id == 0 || crtc.mode.is_none() {
            return Err(CaptureError::new(format!("The display {id} turned off")));
        }
        let fb = self.card(&display.card)?.framebuffer(crtc.fb_id)?;
        let crop = Rect::new(
            crtc.x as i32,
            crtc.y as i32,
            display.width.min(fb.info.width.saturating_sub(crtc.x)),
            display.height.min(fb.info.height.saturating_sub(crtc.y)),
        );
        let frame = self.read(&display.card, &fb, crop)?;
        if !full && self.last.get(id) == Some(&frame) {
            return Ok(None);
        }
        self.last.insert(id.to_string(), frame.clone());
        Ok(Some(frame))
    }

    fn cursor(&mut self, id: &str) -> CaptureResult<KmsCursor> {
        let display = self.display(id)?;
        let Some(plane) = self.cursor_plane(&display)? else {
            return Ok(KmsCursor::HIDDEN);
        };
        if plane.fb_id == 0 {
            return Ok(KmsCursor::HIDDEN);
        }
        let fb = self.card(&display.card)?.framebuffer(plane.fb_id)?;
        if !fb.linear() || !matches!(fb.info.format, convert::ARGB8888 | convert::XRGB8888) {
            // Not a buffer the CPU can read: show no cursor rather than a wrong one.
            return Ok(KmsCursor::HIDDEN);
        }
        let (fd, offset, pitch) = &fb.planes[0];
        let mapping = Mapping::new(fd.as_fd())
            .map_err(|e| CaptureError::new(format!("Cannot map the cursor: {e}")))?;
        let bytes = mapping.bytes().get(*offset as usize..).unwrap_or(&[]);
        let Some(rgba) =
            convert::cursor_rgba(bytes, *pitch as usize, fb.info.width, fb.info.height)
        else {
            return Ok(KmsCursor::HIDDEN);
        };
        let shape = shape_id(fb.info.width, fb.info.height, &rgba);
        if !self.cursors.iter().any(|c| c.shape == shape) {
            if self.cursors.len() >= 16 {
                self.cursors.remove(0);
            }
            self.cursors.push(LastCursor {
                shape,
                image: CursorImage {
                    width: fb.info.width,
                    height: fb.info.height,
                    hotspot_x: 0,
                    hotspot_y: 0,
                    rgba,
                },
            });
        }
        Ok(KmsCursor {
            visible: true,
            x: plane.crtc_x,
            y: plane.crtc_y,
            shape,
        })
    }

    fn cursor_image(&mut self, shape: u32) -> CaptureResult<Option<CursorImage>> {
        Ok(self
            .cursors
            .iter()
            .find(|c| c.shape == shape)
            .map(|c| c.image.clone()))
    }
}

/// FNV-1a over the size and pixels; never 0, which means "hidden".
fn shape_id(width: u32, height: u32, rgba: &[u8]) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for byte in width
        .to_le_bytes()
        .iter()
        .chain(height.to_le_bytes().iter())
        .chain(rgba)
    {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash.max(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shape_ids_change_with_the_image_and_are_never_zero() {
        assert_ne!(shape_id(1, 1, &[0; 4]), shape_id(1, 1, &[1, 0, 0, 0]));
        assert_ne!(shape_id(1, 2, &[0; 8]), shape_id(2, 1, &[0; 8]));
        assert_ne!(shape_id(0, 0, &[]), 0);
    }
}
