//! The physical screen read from the kernel (SPEC-CONSOLE-CAPTURE): DRM/KMS
//! scanout, below any compositor, so the Wayland sign-in screen, the lock
//! screen, any signed-in session and a text console all look the same.
//!
//! - [`card`]: one DRM card through raw ioctls; [`device::KmsReader`]: every
//!   card as one source, run in the root `console-helper` process (it needs
//!   `CAP_SYS_ADMIN` for the framebuffer handles).
//! - [`compose`]: every plane on a CRTC (primary and overlays) drawn in
//!   zpos order with its rectangles, alpha and blend mode; [`convert`]:
//!   linear buffers to BGRX; [`egl`]: the same composition on the GPU for
//!   tiled and compressed buffers, through EGL and GLES loaded at run time.
//! - [`capturer::KmsCapturer`]: the session's [`super::Capturer`] over any
//!   [`KmsSource`] (the helper's pipe in the agent, a fake in tests), laid
//!   out by [`layout`] from the compositor's arrangement ([`compositor`]:
//!   [`mutter`] on GNOME, [`kwin`] on KDE Plasma) when there is
//!   one (SPEC-DESKTOP-ALL-SCREENS).
//!
//! [`displays_from_resources`] is the pure part of discovery: what the
//! kernel reported, in, the displays a session shows, out.

pub mod capturer;
pub mod card;
pub mod compose;
pub mod compositor;
pub mod convert;
pub mod device;
pub mod egl;
mod egl_api;
pub mod kwin;
pub mod layout;
pub mod mutter;
mod uapi;

use super::{CaptureResult, CursorImage, DisplayInfo, Frame, Rect};
use serde::{Deserialize, Serialize};

/// What the session says when no CRTC is scanning anything out.
pub const SCREEN_OFF: &str = "The screen is off";

/// One display mode (`drm_mode_modeinfo`, the parts used).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mode {
    pub width: u32,
    pub height: u32,
    pub refresh: u32,
}

/// One CRTC as `DRM_IOCTL_MODE_GETCRTC` reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Crtc {
    pub id: u32,
    /// The legacy framebuffer (the primary plane's on atomic drivers).
    pub fb_id: u32,
    /// Where scanout starts in the framebuffer.
    pub x: u32,
    pub y: u32,
    /// `None` when the CRTC is off.
    pub mode: Option<Mode>,
}

/// One connector: a socket on the card.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Connector {
    pub id: u32,
    /// The kernel's name, like `eDP-1` or `HDMI-A-1`.
    pub name: String,
    pub connected: bool,
    /// The CRTC driving it, through its current encoder.
    pub crtc_id: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PlaneKind {
    Overlay,
    Primary,
    Cursor,
}

/// How a plane's pixels mix with what is below (`pixel blend mode`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Blend {
    /// Colour already multiplied by the pixel's alpha (the kernel default).
    Premultiplied,
    /// Straight colour, multiplied by the pixel's alpha when blending.
    Coverage,
    /// The pixel's alpha is ignored; only the plane alpha counts.
    None,
}

impl Blend {
    /// From the property's enum name, as the kernel spells it.
    pub fn from_name(name: &str) -> Option<Blend> {
        match name {
            "Pre-multiplied" => Some(Blend::Premultiplied),
            "Coverage" => Some(Blend::Coverage),
            "None" => Some(Blend::None),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Blend::Premultiplied => "pre-multiplied",
            Blend::Coverage => "coverage",
            Blend::None => "none",
        }
    }
}

/// A plane's source rectangle (`SRC_*`): framebuffer pixels in 16.16
/// fixed point.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SourceRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

impl SourceRect {
    /// Whole pixels, shifted into 16.16.
    pub fn pixels(x: u32, y: u32, width: u32, height: u32) -> SourceRect {
        SourceRect {
            x: x << 16,
            y: y << 16,
            width: width << 16,
            height: height << 16,
        }
    }
}

/// One plane and where it is placed (its atomic properties).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plane {
    pub id: u32,
    pub kind: PlaneKind,
    pub crtc_id: u32,
    pub fb_id: u32,
    /// Where it lands on the CRTC (`CRTC_X/Y/W/H`); the cursor's top left
    /// is `crtc.x`, `crtc.y`. The position can be negative.
    pub crtc: Rect,
    /// `None` when the driver has no atomic properties.
    pub src: Option<SourceRect>,
    pub zpos: Option<u64>,
    /// 0 (transparent) to 0xFFFF (opaque); `None` when the plane has none.
    pub alpha: Option<u16>,
    pub blend: Option<Blend>,
    /// `DRM_MODE_ROTATE_*` | `DRM_MODE_REFLECT_*`.
    pub rotation: Option<u64>,
}

/// Everything one card reported.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CardResources {
    /// `card0`, `card1`, …
    pub card: String,
    pub crtcs: Vec<Crtc>,
    pub connectors: Vec<Connector>,
    pub planes: Vec<Plane>,
}

/// One active CRTC shown as a display.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct KmsDisplay {
    /// Stable id: card and connector, like `card1-eDP-1`.
    pub id: String,
    pub name: String,
    pub card: String,
    pub crtc_id: u32,
    /// Position on the virtual desktop (side by side, in connector order)
    /// and the mode's size.
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    /// Where scanout starts in the framebuffer.
    pub fb_x: u32,
    pub fb_y: u32,
    pub primary: bool,
}

impl KmsDisplay {
    pub fn info(&self) -> DisplayInfo {
        DisplayInfo {
            id: self.id.clone(),
            name: self.name.clone(),
            x: self.x,
            y: self.y,
            width: self.width,
            height: self.height,
            scale: 1.0,
            primary: self.primary,
        }
    }
}

/// The pointer as the cursor plane shows it on one display. The plane's
/// top left is the image's top left, so the hotspot is (0, 0).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct KmsCursor {
    pub visible: bool,
    /// Position on the display.
    pub x: i32,
    pub y: i32,
    /// Changes whenever the image does; 0 while hidden.
    pub shape: u32,
}

impl KmsCursor {
    pub const HIDDEN: KmsCursor = KmsCursor {
        visible: false,
        x: 0,
        y: 0,
        shape: 0,
    };
}

/// Where KMS frames come from: [`device::KmsReader`] in the helper, the
/// helper's pipe in the agent, a fake in tests.
pub trait KmsSource {
    /// The active displays now; empty when the screen is off.
    fn displays(&mut self) -> CaptureResult<Vec<KmsDisplay>>;
    /// Display `id`'s image (BGRX, the mode's size), or `None` when it has
    /// not changed since the last call for that display. `full` always
    /// returns the image.
    fn capture(&mut self, id: &str, full: bool) -> CaptureResult<Option<Frame>>;
    /// The cursor plane on display `id`.
    fn cursor(&mut self, id: &str) -> CaptureResult<KmsCursor>;
    /// The image for a shape [`KmsSource::cursor`] returned.
    fn cursor_image(&mut self, shape: u32) -> CaptureResult<Option<CursorImage>>;
}

/// The displays to show: every CRTC with a mode and a framebuffer, named
/// after its connector, ordered by card then connector, and laid out side
/// by side (KMS knows nothing of the compositor's arrangement; the capturer
/// asks the compositor for it, [`layout`]). Empty when
/// every screen is off (a closed lid with nothing else plugged in).
pub fn displays_from_resources(cards: &[CardResources]) -> Vec<KmsDisplay> {
    let mut found: Vec<(String, u32, KmsDisplay)> = Vec::new();
    for card in cards {
        for crtc in &card.crtcs {
            let Some(mode) = &crtc.mode else { continue };
            if mode.width == 0 || mode.height == 0 {
                continue;
            }
            let primary_fb = card
                .planes
                .iter()
                .find(|p| p.kind == PlaneKind::Primary && p.crtc_id == crtc.id && p.fb_id != 0)
                .map_or(crtc.fb_id, |p| p.fb_id);
            if primary_fb == 0 {
                continue;
            }
            let connector = card
                .connectors
                .iter()
                .filter(|c| c.connected && c.crtc_id == Some(crtc.id))
                .min_by_key(|c| c.id);
            let (order, label) = match connector {
                Some(c) => (c.id, c.name.clone()),
                None => (u32::MAX, format!("CRTC-{}", crtc.id)),
            };
            found.push((
                card.card.clone(),
                order,
                KmsDisplay {
                    id: format!("{}-{label}", card.card),
                    name: label,
                    card: card.card.clone(),
                    crtc_id: crtc.id,
                    x: 0,
                    y: 0,
                    width: mode.width,
                    height: mode.height,
                    fb_x: crtc.x,
                    fb_y: crtc.y,
                    primary: false,
                },
            ));
        }
    }
    found.sort_by(|a, b| (card_number(&a.0), a.1).cmp(&(card_number(&b.0), b.1)));
    let mut x = 0i32;
    let mut displays: Vec<KmsDisplay> = found.into_iter().map(|(_, _, d)| d).collect();
    for (index, display) in displays.iter_mut().enumerate() {
        display.x = x;
        display.primary = index == 0;
        x = x.saturating_add(i32::try_from(display.width).unwrap_or(i32::MAX));
    }
    displays
}

fn card_number(card: &str) -> u32 {
    card.trim_start_matches("card").parse().unwrap_or(u32::MAX)
}

#[cfg(test)]
mod tests {
    use super::convert::{convert, fourcc, BufferLayout};
    use super::*;

    fn mode(width: u32, height: u32) -> Option<Mode> {
        Some(Mode {
            width,
            height,
            refresh: 60,
        })
    }

    fn connector(id: u32, name: &str, crtc: Option<u32>) -> Connector {
        Connector {
            id,
            name: name.into(),
            connected: crtc.is_some(),
            crtc_id: crtc,
        }
    }

    fn plane(id: u32, kind: PlaneKind, crtc_id: u32, fb_id: u32) -> Plane {
        Plane {
            id,
            kind,
            crtc_id,
            fb_id,
            crtc: Rect::new(0, 0, 0, 0),
            src: None,
            zpos: None,
            alpha: None,
            blend: None,
            rotation: None,
        }
    }

    /// A laptop with its panel on CRTC 51 and an HDMI monitor on CRTC 71
    /// (scanning out from x = 1920 of a shared framebuffer), plus an idle
    /// third CRTC.
    fn laptop_and_monitor() -> CardResources {
        CardResources {
            card: "card1".into(),
            crtcs: vec![
                Crtc {
                    id: 51,
                    fb_id: 0,
                    x: 0,
                    y: 0,
                    mode: mode(1920, 1200),
                },
                Crtc {
                    id: 71,
                    fb_id: 120,
                    x: 1920,
                    y: 0,
                    mode: mode(2560, 1440),
                },
                Crtc {
                    id: 91,
                    fb_id: 0,
                    x: 0,
                    y: 0,
                    mode: None,
                },
            ],
            connectors: vec![
                connector(236, "HDMI-A-1", Some(71)),
                connector(230, "eDP-1", Some(51)),
                connector(240, "DP-1", None),
            ],
            planes: vec![
                plane(31, PlaneKind::Primary, 51, 130),
                plane(32, PlaneKind::Cursor, 51, 131),
                plane(41, PlaneKind::Primary, 71, 0),
                plane(61, PlaneKind::Primary, 0, 0),
            ],
        }
    }

    #[test]
    fn displays_from_resources() {
        let displays = super::displays_from_resources(&[laptop_and_monitor()]);
        let summary: Vec<_> = displays
            .iter()
            .map(|d| (d.id.as_str(), d.crtc_id, d.x, d.width, d.height, d.primary))
            .collect();
        // The panel comes first (lower connector id) and is primary; the
        // monitor sits to its right. The idle CRTC is not a display.
        assert_eq!(
            summary,
            vec![
                ("card1-eDP-1", 51, 0, 1920, 1200, true),
                ("card1-HDMI-A-1", 71, 1920, 2560, 1440, false),
            ]
        );
        // The legacy fb (CRTC 71) counts when the plane reports none, and the
        // scanout offset into a shared framebuffer is kept.
        assert_eq!((displays[1].fb_x, displays[1].fb_y), (1920, 0));
        assert_eq!(displays[0].info().rect(), Rect::new(0, 0, 1920, 1200));

        // A second card is laid out after the first, whatever order it came in.
        let mut second = laptop_and_monitor();
        second.card = "card0".into();
        second.crtcs.truncate(1);
        let both = super::displays_from_resources(&[laptop_and_monitor(), second]);
        assert_eq!(both[0].id, "card0-eDP-1");
        assert_eq!(both[1].x, 1920);

        // A CRTC with a mode but no connector still shows, by CRTC.
        let mut orphan = laptop_and_monitor();
        orphan.connectors.clear();
        let names: Vec<_> = super::displays_from_resources(&[orphan])
            .into_iter()
            .map(|d| d.name)
            .collect();
        assert_eq!(names, vec!["CRTC-51", "CRTC-71"]);

        // Lid closed, nothing else plugged in: every CRTC is off.
        let mut closed = laptop_and_monitor();
        for crtc in &mut closed.crtcs {
            crtc.mode = None;
        }
        assert!(super::displays_from_resources(&[closed]).is_empty());
        // A mode with no framebuffer (being set up) is not shown either.
        let mut blank = laptop_and_monitor();
        blank.planes.clear();
        blank.crtcs[1].fb_id = 0;
        assert!(super::displays_from_resources(&[blank]).is_empty());
        assert!(super::displays_from_resources(&[]).is_empty());
    }

    fn layout(format: u32, pitch: u32, width: u32, height: u32) -> BufferLayout {
        BufferLayout {
            format,
            pitch,
            offset: 0,
            width,
            height,
        }
    }

    #[test]
    fn linear_conversion_and_refusals() {
        let all = Rect::new(0, 0, 2, 2);
        // XRGB8888 and ARGB8888 are already B, G, R, X in memory; the pitch
        // has 4 bytes of padding per row.
        let xrgb = [
            1, 2, 3, 0xFF, 4, 5, 6, 0xFF, 9, 9, 9, 9, //
            7, 8, 9, 0x00, 10, 11, 12, 0x80, 9, 9, 9, 9,
        ];
        for format in [fourcc(b"XR24"), fourcc(b"AR24")] {
            let frame = convert(&xrgb, &layout(format, 12, 2, 2), all).unwrap();
            assert_eq!((frame.width, frame.height, frame.stride), (2, 2, 8));
            assert_eq!(frame.row(0), &[1, 2, 3, 0xFF, 4, 5, 6, 0xFF]);
            assert_eq!(frame.row(1), &[7, 8, 9, 0x00, 10, 11, 12, 0x80]);
        }
        // XBGR8888 is R, G, B, X: swapped into BGRX.
        let xbgr = [1, 2, 3, 0, 4, 5, 6, 0];
        let frame = convert(
            &xbgr,
            &layout(fourcc(b"XB24"), 8, 2, 1),
            Rect::new(0, 0, 2, 1),
        )
        .unwrap();
        assert_eq!(frame.row(0), &[3, 2, 1, 0, 6, 5, 4, 0]);
        // A crop (a CRTC scanning out the right half of a shared buffer).
        let frame = convert(
            &xrgb,
            &layout(fourcc(b"XR24"), 12, 2, 2),
            Rect::new(1, 1, 1, 1),
        )
        .unwrap();
        assert_eq!(frame.row(0), &[10, 11, 12, 0x80]);
        // XRGB2101010: red full, green half, blue zero; ABGR2101010 the same
        // colour with red and blue swapped.
        let red_green: u32 = (0x3FF << 20) | (0x200 << 10);
        let frame = convert(
            &red_green.to_le_bytes(),
            &layout(fourcc(b"XR30"), 4, 1, 1),
            Rect::new(0, 0, 1, 1),
        )
        .unwrap();
        assert_eq!(frame.row(0), &[0, 0x80, 0xFF, 0xFF]);
        let swapped: u32 = (0b11 << 30) | (0x200 << 10) | 0x3FF;
        let frame = convert(
            &swapped.to_le_bytes(),
            &layout(fourcc(b"AB30"), 4, 1, 1),
            Rect::new(0, 0, 1, 1),
        )
        .unwrap();
        assert_eq!(frame.row(0), &[0, 0x80, 0xFF, 0xFF]);
        // ARGB2101010 keeps its two bits of alpha (one third here).
        let third: u32 = (0b01 << 30) | (0x3FF << 20);
        let frame = convert(
            &third.to_le_bytes(),
            &layout(fourcc(b"AR30"), 4, 1, 1),
            Rect::new(0, 0, 1, 1),
        )
        .unwrap();
        assert_eq!(frame.row(0), &[0, 0, 0xFF, 85]);
        assert!(super::convert::has_alpha(fourcc(b"AR24")));
        assert!(!super::convert::has_alpha(fourcc(b"XR24")));
        // RGB565 white and pure blue.
        let rgb565 = [0xFF, 0xFF, 0x1F, 0x00];
        let frame = convert(
            &rgb565,
            &layout(fourcc(b"RG16"), 4, 2, 1),
            Rect::new(0, 0, 2, 1),
        )
        .unwrap();
        assert_eq!(frame.row(0), &[0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0, 0, 0xFF]);

        // Refusals: an unknown format is named, not guessed.
        let error = convert(&xrgb, &layout(fourcc(b"NV12"), 12, 2, 2), all).unwrap_err();
        assert!(error.contains("NV12"), "{error}");
        // A pitch narrower than a row.
        assert!(convert(&xrgb, &layout(fourcc(b"XR24"), 4, 2, 2), all)
            .unwrap_err()
            .contains("pitch"));
        // A buffer shorter than its rows.
        assert!(
            convert(&xrgb[..19], &layout(fourcc(b"XR24"), 12, 2, 2), all)
                .unwrap_err()
                .contains("short")
        );
        // An offset that runs past the end.
        let mut shifted = layout(fourcc(b"XR24"), 12, 2, 2);
        shifted.offset = 8;
        assert!(convert(&xrgb, &shifted, all).is_err());
        // A crop outside the framebuffer.
        assert!(convert(
            &xrgb,
            &layout(fourcc(b"XR24"), 12, 2, 2),
            Rect::new(1, 0, 2, 2)
        )
        .unwrap_err()
        .contains("outside"));
        assert!(convert(
            &xrgb,
            &layout(fourcc(b"XR24"), 12, 2, 2),
            Rect::new(0, 0, 0, 2)
        )
        .is_err());
    }
}
