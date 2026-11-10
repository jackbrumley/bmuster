//! Every plane on a CRTC as one picture (SPEC-CONSOLE-CAPTURE version 2).
//!
//! A compositor can hand a client's buffer straight to the display
//! hardware: on an overlay plane, or on the primary plane scaled from a
//! source rectangle to a destination one. The screen a person sees is
//! the planes blended bottom first, so capture does the same:
//!
//! - [`layers`]: which planes scan out a CRTC, in drawing order;
//! - [`Placement`]: one layer's rectangle and rotation maths, shared by
//!   the CPU path here and the GPU path in [`super::egl`];
//! - [`compose_cpu`]: blending linear layers on the CPU;
//! - [`PlaneWatch`] and [`describe`]: the log line per plane.

use super::card::FramebufferInfo;
use super::convert::fourcc_name;
use super::{Blend, Crtc, Plane, PlaneKind, SourceRect};
use crate::capture::{Frame, Rect, BYTES_PER_PIXEL};
use std::collections::HashMap;

/// `DRM_MODE_ROTATE_*` and `DRM_MODE_REFLECT_*` (`drm_mode.h`).
pub const ROTATE_0: u64 = 1 << 0;
pub const ROTATE_90: u64 = 1 << 1;
pub const ROTATE_180: u64 = 1 << 2;
pub const ROTATE_270: u64 = 1 << 3;
pub const REFLECT_X: u64 = 1 << 4;
pub const REFLECT_Y: u64 = 1 << 5;
const ROTATE_MASK: u64 = ROTATE_0 | ROTATE_90 | ROTATE_180 | ROTATE_270;

/// A plane alpha of fully opaque (the kernel default).
pub const OPAQUE: u16 = 0xFFFF;

/// One plane to draw: what it reads and where it lands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Layer {
    /// The plane's id; 0 when only the CRTC's legacy framebuffer is known.
    pub plane: u32,
    pub fb_id: u32,
    pub src: SourceRect,
    /// On the CRTC; may hang off its edges.
    pub dst: Rect,
    pub alpha: u16,
    pub blend: Blend,
    pub rotation: u64,
}

/// The planes scanning out `crtc`, bottom first: by zpos, the primary
/// plane below overlays on a tie, then by plane id. The cursor plane is
/// not drawn (it is sent as the session's cursor). Without atomic
/// properties the CRTC's legacy framebuffer is copied from its offset at
/// the mode's size, as version 1 did; an overlay without them cannot be
/// placed and is left out.
pub fn layers(crtc: &Crtc, planes: &[Plane]) -> Vec<Layer> {
    let Some(mode) = &crtc.mode else {
        return Vec::new();
    };
    let on_crtc = || {
        planes
            .iter()
            .filter(|p| p.crtc_id == crtc.id && p.kind != PlaneKind::Cursor)
    };
    let mut drawn: Vec<((u64, bool, u32), Layer)> = Vec::new();
    for plane in on_crtc() {
        let Some(src) = plane.src else { continue };
        if plane.fb_id == 0
            || src.width == 0
            || src.height == 0
            || plane.crtc.width == 0
            || plane.crtc.height == 0
        {
            continue;
        }
        let overlay = plane.kind != PlaneKind::Primary;
        drawn.push((
            (plane.zpos.unwrap_or(u64::from(overlay)), overlay, plane.id),
            Layer {
                plane: plane.id,
                fb_id: plane.fb_id,
                src,
                dst: plane.crtc,
                alpha: plane.alpha.unwrap_or(OPAQUE),
                blend: plane.blend.unwrap_or(Blend::Premultiplied),
                rotation: plane.rotation.unwrap_or(ROTATE_0),
            },
        ));
    }
    let has_primary = drawn.iter().any(|((_, overlay, _), _)| !overlay);
    if !has_primary {
        let primary = on_crtc().find(|p| p.kind == PlaneKind::Primary && p.src.is_none());
        let fb_id = match (crtc.fb_id, primary) {
            (0, Some(plane)) => plane.fb_id,
            (fb_id, _) => fb_id,
        };
        if fb_id != 0 {
            drawn.push((
                (0, false, 0),
                Layer {
                    plane: primary.map_or(0, |p| p.id),
                    fb_id,
                    src: SourceRect::pixels(crtc.x, crtc.y, mode.width, mode.height),
                    dst: Rect::new(0, 0, mode.width, mode.height),
                    alpha: OPAQUE,
                    blend: Blend::Premultiplied,
                    rotation: ROTATE_0,
                },
            ));
        }
    }
    drawn.sort_by_key(|(key, _)| *key);
    drawn.into_iter().map(|(_, layer)| layer).collect()
}

/// A layer on a framebuffer of known size: the maths both paths use.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Placement {
    /// The source in framebuffer pixels: x, y, width, height.
    pub src: [f64; 4],
    pub dst: Rect,
    /// The framebuffer's width and height.
    pub buffer: (u32, u32),
    pub rotation: u64,
    pub alpha: u16,
    pub blend: Blend,
}

impl Placement {
    /// Refuses a source outside the framebuffer (the kernel never scans one
    /// out, so it means the plane changed between two reads) and empty
    /// rectangles.
    pub fn new(layer: &Layer, width: u32, height: u32) -> Result<Placement, String> {
        let s = layer.src;
        if s.width == 0
            || s.height == 0
            || u64::from(s.x) + u64::from(s.width) > u64::from(width) << 16
            || u64::from(s.y) + u64::from(s.height) > u64::from(height) << 16
        {
            return Err(format!(
                "Plane {} reads {} outside its {width}x{height} framebuffer",
                layer.plane,
                source_text(&s)
            ));
        }
        if layer.dst.width == 0 || layer.dst.height == 0 {
            return Err(format!("Plane {} has an empty destination", layer.plane));
        }
        let fixed = |v: u32| f64::from(v) / 65536.0;
        Ok(Placement {
            src: [fixed(s.x), fixed(s.y), fixed(s.width), fixed(s.height)],
            dst: layer.dst,
            buffer: (width, height),
            rotation: layer.rotation,
            alpha: layer.alpha,
            blend: layer.blend,
        })
    }

    /// The framebuffer point shown at (`u`, `v`) of the destination, each
    /// 0 (left, top) to 1 (right, bottom).
    pub fn source(&self, u: f64, v: f64) -> (f64, f64) {
        let (s, t) = unrotate(self.rotation, u, v);
        (self.src[0] + s * self.src[2], self.src[1] + t * self.src[3])
    }

    /// Texture coordinates (0 to 1 of the framebuffer) at the destination's
    /// top-left, top-right, bottom-left and bottom-right corners.
    pub fn corners(&self) -> [(f64, f64); 4] {
        let (width, height) = (f64::from(self.buffer.0), f64::from(self.buffer.1));
        [(0.0, 0.0), (1.0, 0.0), (0.0, 1.0), (1.0, 1.0)].map(|(u, v)| {
            let (x, y) = self.source(u, v);
            (x / width, y / height)
        })
    }

    /// The layer as a GPU triangle strip on a `width` × `height` target:
    /// clip-space positions and texture coordinates, corner by corner as
    /// [`Placement::corners`]. Row 0 of the target is the bottom of clip
    /// space, which glReadPixels returns first, so the frame comes out top
    /// first. Corners off the target are left to the GPU to clip.
    pub fn quad(&self, width: u32, height: u32) -> ([f32; 8], [f32; 8]) {
        let (w, h) = (f64::from(width), f64::from(height));
        let x = |at: f64| (-1.0 + 2.0 * at / w) as f32;
        let y = |at: f64| (-1.0 + 2.0 * at / h) as f32;
        let (left, top) = (f64::from(self.dst.x), f64::from(self.dst.y));
        let (right, bottom) = (
            left + f64::from(self.dst.width),
            top + f64::from(self.dst.height),
        );
        let positions = [
            x(left),
            y(top),
            x(right),
            y(top),
            x(left),
            y(bottom),
            x(right),
            y(bottom),
        ];
        let mut texture = [0.0f32; 8];
        for (index, (s, t)) in self.corners().iter().enumerate() {
            texture[index * 2] = *s as f32;
            texture[index * 2 + 1] = *t as f32;
        }
        (positions, texture)
    }

    fn quarter_turn(&self) -> bool {
        matches!(self.rotation & ROTATE_MASK, ROTATE_90 | ROTATE_270)
    }

    /// True when the source is resized to fit the destination, or starts
    /// between two pixels: the GPU then filters instead of copying.
    pub fn scaled(&self) -> bool {
        let (width, height) = if self.quarter_turn() {
            (self.src[3], self.src[2])
        } else {
            (self.src[2], self.src[3])
        };
        width != f64::from(self.dst.width)
            || height != f64::from(self.dst.height)
            || self.src[0].fract() != 0.0
            || self.src[1].fract() != 0.0
    }

    /// The part of a `width` × `height` CRTC the layer covers.
    pub fn visible(&self, width: u32, height: u32) -> Option<Rect> {
        self.dst.intersect(&Rect::new(0, 0, width, height))
    }

    /// The whole framebuffer pixels the source touches.
    pub fn source_box(&self) -> Rect {
        let (width, height) = (f64::from(self.buffer.0), f64::from(self.buffer.1));
        let left = self.src[0].floor();
        let top = self.src[1].floor();
        let right = (self.src[0] + self.src[2]).ceil().min(width);
        let bottom = (self.src[1] + self.src[3]).ceil().min(height);
        Rect::new(
            left as i32,
            top as i32,
            (right - left) as u32,
            (bottom - top) as u32,
        )
    }

    /// True when, drawn first over black, the layer is a plain copy of
    /// [`Placement::source_box`] filling the whole CRTC.
    pub fn is_copy(&self, width: u32, height: u32) -> bool {
        self.dst == Rect::new(0, 0, width, height)
            && self.rotation & (ROTATE_MASK | REFLECT_X | REFLECT_Y) == ROTATE_0
            && !self.scaled()
            && self.alpha == OPAQUE
            && self.blend != Blend::Coverage
    }
}

/// Where in the source (0 to 1 each way) the destination point (`u`, `v`)
/// comes from. The kernel reflects the source, then rotates it counter
/// clockwise (`drm_rect_rotate`); this undoes both.
fn unrotate(rotation: u64, u: f64, v: f64) -> (f64, f64) {
    let (s, t) = match rotation & ROTATE_MASK {
        ROTATE_90 => (1.0 - v, u),
        ROTATE_180 => (1.0 - u, 1.0 - v),
        ROTATE_270 => (v, 1.0 - u),
        _ => (u, v),
    };
    (
        if rotation & REFLECT_X != 0 {
            1.0 - s
        } else {
            s
        },
        if rotation & REFLECT_Y != 0 {
            1.0 - t
        } else {
            t
        },
    )
}

/// One linear layer for the CPU.
pub struct CpuLayer {
    pub placement: Placement,
    /// [`Placement::source_box`] of the framebuffer as B, G, R and alpha
    /// (or padding).
    pub pixels: Frame,
    /// False for formats whose fourth byte is padding (XRGB): opaque.
    pub alpha_channel: bool,
}

/// The layers blended bottom first onto a black `width` × `height`
/// canvas. A first layer that is a plain copy becomes the canvas itself.
pub fn compose_cpu(width: u32, height: u32, layers: Vec<CpuLayer>) -> Frame {
    let mut canvas = Frame::new(width, height);
    for (index, layer) in layers.into_iter().enumerate() {
        if index == 0
            && layer.placement.is_copy(width, height)
            && (layer.pixels.width, layer.pixels.height) == (width, height)
        {
            canvas = layer.pixels;
        } else {
            blend_layer(&mut canvas, &layer);
        }
    }
    canvas
}

/// Samples each covered canvas pixel's centre from the layer (nearest
/// pixel) and blends it in.
fn blend_layer(canvas: &mut Frame, layer: &CpuLayer) {
    let placement = &layer.placement;
    let pixels = &layer.pixels;
    let Some(area) = placement.visible(canvas.width, canvas.height) else {
        return;
    };
    if pixels.width == 0 || pixels.height == 0 {
        return;
    }
    let origin = placement.source_box();
    let (left, top) = (f64::from(placement.dst.x), f64::from(placement.dst.y));
    let (width, height) = (
        f64::from(placement.dst.width),
        f64::from(placement.dst.height),
    );
    let (last_x, last_y) = (i64::from(pixels.width) - 1, i64::from(pixels.height) - 1);
    // `visible` is inside the canvas, so every coordinate is not negative.
    let (x0, y0) = (area.x as u32, area.y as u32);
    for y in y0..y0 + area.height {
        let v = (f64::from(y) + 0.5 - top) / height;
        let row = y as usize * canvas.stride;
        for x in x0..x0 + area.width {
            let u = (f64::from(x) + 0.5 - left) / width;
            let (sx, sy) = placement.source(u, v);
            let px = (sx.floor() as i64 - i64::from(origin.x)).clamp(0, last_x) as usize;
            let py = (sy.floor() as i64 - i64::from(origin.y)).clamp(0, last_y) as usize;
            let from = py * pixels.stride + px * BYTES_PER_PIXEL;
            let to = row + x as usize * BYTES_PER_PIXEL;
            blend_pixel(
                &mut canvas.data[to..to + BYTES_PER_PIXEL],
                &pixels.data[from..from + BYTES_PER_PIXEL],
                layer.alpha_channel,
                placement.alpha,
                placement.blend,
            );
        }
    }
}

/// One pixel over what is below, as the display hardware blends it:
/// pre-multiplied `c·pa + below·(1 − a·pa)`, coverage
/// `c·a·pa + below·(1 − a·pa)`, none `c·pa + below·(1 − pa)`.
fn blend_pixel(
    below: &mut [u8],
    pixel: &[u8],
    alpha_channel: bool,
    plane_alpha: u16,
    blend: Blend,
) {
    const FULL: u64 = 0xFFFF;
    let plane = u64::from(plane_alpha);
    let alpha = if alpha_channel && blend != Blend::None {
        u64::from(pixel[3])
    } else {
        255
    };
    // The source's coverage out of 255; what is below keeps the rest.
    let cover = (alpha * plane + FULL / 2) / FULL;
    // What the colour is multiplied by, out of 255 × 0xFFFF.
    let scale = match blend {
        Blend::Premultiplied | Blend::None => plane * 255,
        Blend::Coverage => alpha * plane,
    };
    let whole = 255 * FULL;
    for channel in 0..3 {
        let colour = (u64::from(pixel[channel]) * scale + whole / 2) / whole;
        let kept = (u64::from(below[channel]) * (255 - cover) + 127) / 255;
        below[channel] = (colour + kept).min(255) as u8;
    }
}

/// Remembers each display's planes, to log them when they change.
#[derive(Default)]
pub struct PlaneWatch {
    last: HashMap<String, Vec<String>>,
}

impl PlaneWatch {
    /// The lines to log for `display` when its planes changed since the
    /// last call (always on the first), one per plane. A new framebuffer
    /// id is not a change (compositors flip every frame), and the cursor
    /// plane is left out of the comparison (it moves, hides and shows) but
    /// still listed.
    pub fn update(
        &mut self,
        display: &str,
        planes: &[(Plane, Option<FramebufferInfo>)],
    ) -> Option<Vec<String>> {
        let steady: Vec<String> = planes
            .iter()
            .filter(|(plane, _)| plane.kind != PlaneKind::Cursor)
            .map(|(plane, info)| {
                let mut plane = plane.clone();
                plane.fb_id = 0;
                describe(&plane, info.as_ref())
            })
            .collect();
        if self.last.get(display) == Some(&steady) {
            return None;
        }
        self.last.insert(display.to_string(), steady);
        Some(
            planes
                .iter()
                .map(|(plane, info)| {
                    format!("KMS display {display}: {}", describe(plane, info.as_ref()))
                })
                .collect(),
        )
    }

    /// Forgets displays that are gone.
    pub fn retain(&mut self, keep: impl Fn(&str) -> bool) {
        self.last.retain(|display, _| keep(display));
    }
}

/// One plane as a line for the log and `kms-probe`: id, type, framebuffer
/// and its format, `SRC_*` (16.16 shown as decimals), `CRTC_*`, zpos,
/// alpha, blend mode and rotation (`-` when the plane has none).
pub fn describe(plane: &Plane, info: Option<&FramebufferInfo>) -> String {
    let kind = match plane.kind {
        PlaneKind::Primary => "primary",
        PlaneKind::Overlay => "overlay",
        PlaneKind::Cursor => "cursor",
    };
    let format = match info {
        Some(info) => format!(
            "{} {}x{} modifier {}",
            fourcc_name(info.format),
            info.width,
            info.height,
            info.modifier
                .map_or("none".to_string(), |m| format!("0x{m:016x}"))
        ),
        None => "(not readable)".to_string(),
    };
    let none = || "-".to_string();
    format!(
        "plane {} {kind} fb {} {format}, src {}, crtc {}x{}{:+}{:+}, zpos {}, alpha {}, blend {}, rotation {}",
        plane.id,
        plane.fb_id,
        plane.src.as_ref().map_or_else(none, source_text),
        plane.crtc.width,
        plane.crtc.height,
        plane.crtc.x,
        plane.crtc.y,
        plane.zpos.map_or_else(none, |z| z.to_string()),
        plane.alpha.map_or_else(none, |a| format!("0x{a:04x}")),
        plane.blend.map_or_else(none, |b| b.name().to_string()),
        plane.rotation.map_or_else(none, rotation_text),
    )
}

/// `WxH+X+Y` of a 16.16 rectangle, fractions to four places.
fn source_text(src: &SourceRect) -> String {
    let fixed = |v: u32| {
        let fraction = u64::from(v & 0xFFFF) * 10_000 / 65_536;
        if fraction == 0 {
            (v >> 16).to_string()
        } else {
            format!("{}.{fraction:04}", v >> 16)
        }
    };
    format!(
        "{}x{}+{}+{}",
        fixed(src.width),
        fixed(src.height),
        fixed(src.x),
        fixed(src.y)
    )
}

fn rotation_text(rotation: u64) -> String {
    let names = [
        (ROTATE_0, "rotate-0"),
        (ROTATE_90, "rotate-90"),
        (ROTATE_180, "rotate-180"),
        (ROTATE_270, "rotate-270"),
        (REFLECT_X, "reflect-x"),
        (REFLECT_Y, "reflect-y"),
    ];
    let known: u64 = names.iter().map(|(bit, _)| bit).sum();
    if rotation & !known != 0 || rotation == 0 {
        return format!("0x{rotation:x}");
    }
    names
        .iter()
        .filter(|(bit, _)| rotation & bit != 0)
        .map(|(_, name)| *name)
        .collect::<Vec<_>>()
        .join("|")
}

#[cfg(test)]
#[path = "compose_tests.rs"]
mod tests;
