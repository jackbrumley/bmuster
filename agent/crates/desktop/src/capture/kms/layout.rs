//! Where the KMS displays really are (SPEC-DESKTOP-ALL-SCREENS, Layout).
//!
//! KMS knows each screen's mode but not how the compositor arranges them,
//! so the helper lays them out side by side. The desktop's compositor
//! knows: mutter on GNOME ([`super::mutter`]) and KWin on KDE Plasma
//! ([`super::kwin`]) each say where every monitor sits on the stage, at
//! what scale, by connector name, as a [`CompositorLayout`]. [`arrange`]
//! turns that into BMuster's desktop:
//!
//! - **Stage**: the compositor's layout. In the logical layout mode
//!   (Wayland's default) a monitor of mode `w × h` at scale `s` covers
//!   `round(w / s) × round(h / s)` stage pixels; in mutter's physical mode,
//!   `w × h`. KWin gives the logical size itself.
//! - **Desktop**: the stage scaled by the smallest monitor scale `k` (1 in
//!   the physical mode), so a set of monitors at one scale keeps every
//!   physical pixel, and a higher-DPI monitor beside a lower one is
//!   resampled down to match (one desktop unit is the same size on every
//!   monitor, as on the stage). Edges are rounded from the stage edges, so
//!   monitors that touch on the stage touch on the desktop.
//! - **Pointer**: each monitor's desktop and stage rectangles go to the
//!   uinput pointer ([`crate::input::absolute::PointerMap`]).
//!
//! Anything that does not match (another compositor, the greeter, a
//! connector the compositor does not list, a mode that differs, a rotated
//! monitor) falls back to the side-by-side layout, with the reason.

use super::KmsDisplay;
use crate::capture::{DisplayInfo, Rect};
use crate::input::absolute::{bounding, Mapped, PointerMap};

/// Which compositor said where the monitors are.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Compositor {
    /// GNOME's (`org.gnome.Mutter.DisplayConfig`).
    Mutter,
    /// KDE Plasma's (`org.kde.KWin`).
    KWin,
}

impl Compositor {
    /// The name the log and the fallback reasons use.
    pub fn name(self) -> &'static str {
        match self {
            Compositor::Mutter => "mutter",
            Compositor::KWin => "KWin",
        }
    }
}

/// How the compositor sizes monitors on its stage (mutter's `layout-mode`;
/// KWin is always logical).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LayoutMode {
    /// Stage pixels are logical: a monitor's size is its mode over its scale.
    Logical,
    /// Stage pixels are physical: a monitor's size is its mode.
    Physical,
}

/// How big a monitor is, as its compositor says it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum MonitorSize {
    /// Mutter: the monitor's current mode (none when it has none); its
    /// stage size follows from the layout mode and the scale.
    Mode(Option<(u32, u32)>),
    /// KWin: the monitor's size on the stage, already in logical pixels.
    Stage(u32, u32),
}

/// One connector's monitor and its place on the stage. Mirrored monitors
/// are two of these at the same place.
#[derive(Debug, Clone, PartialEq)]
pub struct PlacedMonitor {
    /// The connector, as the compositor names it (`eDP-1`, `HDMI-1`,
    /// `HDMI-A-1`, `DP-2`).
    pub connector: String,
    pub x: i32,
    pub y: i32,
    pub scale: f64,
    /// 0 is normal; 1–3 rotate, 4–7 flip (mutter's numbers). KWin does not
    /// say: a turned KWin monitor shows as a stage size that fits its KMS
    /// mode only sideways.
    pub transform: u32,
    pub primary: bool,
    pub size: MonitorSize,
}

/// Where a compositor puts every monitor.
#[derive(Debug, Clone, PartialEq)]
pub struct CompositorLayout {
    pub compositor: Compositor,
    pub mode: LayoutMode,
    pub monitors: Vec<PlacedMonitor>,
}

/// Where the layout came from, for the log and the spec's "layout source".
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LayoutSource {
    Compositor(Compositor),
    /// The helper's side-by-side order, and why the compositor's was not
    /// used.
    SideBySide {
        reason: String,
    },
}

/// The displays a session shows and the pointer's map for them.
#[derive(Debug, Clone, PartialEq)]
pub struct Arrangement {
    pub displays: Vec<DisplayInfo>,
    pub pointer: PointerMap,
    pub source: LayoutSource,
}

/// Furthest a stage coordinate may be from 0 before the layout is refused.
const MAX_COORDINATE: i64 = 1 << 16;

/// Lays `kms` out by the compositor's layout, or side by side when there
/// is none or it does not fit (`layout` holds the reason then).
pub fn arrange(kms: &[KmsDisplay], layout: Result<&CompositorLayout, String>) -> Arrangement {
    match layout.and_then(|layout| from_compositor(kms, layout)) {
        Ok((displays, mapped, compositor)) => Arrangement {
            displays,
            pointer: PointerMap::new(mapped),
            source: LayoutSource::Compositor(compositor),
        },
        Err(reason) => side_by_side(kms, reason),
    }
}

/// The helper's layout: side by side, the same on the desktop and stage.
pub fn side_by_side(kms: &[KmsDisplay], reason: String) -> Arrangement {
    let displays: Vec<DisplayInfo> = kms.iter().map(KmsDisplay::info).collect();
    let rects: Vec<Rect> = displays.iter().map(DisplayInfo::rect).collect();
    Arrangement {
        displays,
        pointer: PointerMap::identity(&rects),
        source: LayoutSource::SideBySide { reason },
    }
}

/// Whether a KMS connector name (the kernel's) is the compositor's `name`.
/// Mutter calls HDMI type A plain `HDMI`; KWin uses the kernel's names.
pub fn same_connector(kms: &str, compositor: &str) -> bool {
    plain(kms) == plain(compositor)
}

/// A connector name in lower case, with `HDMI-A-` written `HDMI-`.
fn plain(name: &str) -> String {
    let lower = name.to_ascii_lowercase();
    match lower.strip_prefix("hdmi-a-") {
        Some(number) => format!("hdmi-{number}"),
        None => lower,
    }
}

/// A monitor's size on the stage, checked against its KMS mode.
fn stage_size(
    display: &KmsDisplay,
    monitor: &PlacedMonitor,
    layout: &CompositorLayout,
) -> Result<(u32, u32), String> {
    let who = layout.compositor.name();
    let name = &display.name;
    match monitor.size {
        MonitorSize::Mode(None) => Err(format!("{who} has no mode for {name}")),
        MonitorSize::Mode(Some((width, height))) => {
            if (width, height) != (display.width, display.height) {
                return Err(format!(
                    "{who} shows {name} at {width}x{height}, KMS at {}x{}",
                    display.width, display.height
                ));
            }
            Ok(match layout.mode {
                LayoutMode::Logical => (
                    (f64::from(width) / monitor.scale).round() as u32,
                    (f64::from(height) / monitor.scale).round() as u32,
                ),
                LayoutMode::Physical => (width, height),
            })
        }
        MonitorSize::Stage(width, height) => {
            // The stage size times the scale is the KMS mode, give or take
            // KWin rounding the logical size to whole pixels.
            let near = |mode: u32, stage: u32| {
                (f64::from(mode) - f64::from(stage) * monitor.scale).abs() <= monitor.scale + 1.0
            };
            if near(display.width, width) && near(display.height, height) {
                Ok((width, height))
            } else if near(display.height, width) && near(display.width, height) {
                // KMS scans out in panel orientation; the stage is turned.
                Err(format!("{name} is rotated"))
            } else {
                Err(format!(
                    "{who} shows {name} at {width}x{height} at scale {}, KMS at {}x{}",
                    monitor.scale, display.width, display.height
                ))
            }
        }
    }
}

fn from_compositor(
    kms: &[KmsDisplay],
    layout: &CompositorLayout,
) -> Result<(Vec<DisplayInfo>, Vec<Mapped>, Compositor), String> {
    if kms.is_empty() {
        return Err("there are no displays".into());
    }
    let who = layout.compositor.name();
    let mut placed: Vec<(&KmsDisplay, &PlacedMonitor, Rect)> = Vec::new();
    for display in kms {
        // Compositors name connectors without the card: two cards with a
        // DP-1 each cannot be told apart.
        let twins = kms
            .iter()
            .filter(|other| same_connector(&other.name, &display.name))
            .count();
        if twins > 1 {
            return Err(format!("two screens are called {}", display.name));
        }
        let monitor = layout
            .monitors
            .iter()
            .find(|m| same_connector(&display.name, &m.connector))
            .ok_or_else(|| format!("{who} does not show {}", display.name))?;
        if monitor.transform != 0 {
            return Err(format!("{} is rotated", display.name));
        }
        if !(monitor.scale.is_finite() && (0.25..=8.0).contains(&monitor.scale)) {
            return Err(format!("{} has scale {}", display.name, monitor.scale));
        }
        let (stage_width, stage_height) = stage_size(display, monitor, layout)?;
        let stage = Rect::new(
            monitor.x,
            monitor.y,
            stage_width.max(1),
            stage_height.max(1),
        );
        let far = [
            i64::from(stage.x),
            i64::from(stage.y),
            stage.right(),
            stage.bottom(),
        ];
        if far.iter().any(|v| v.abs() > MAX_COORDINATE) {
            return Err(format!("{} is placed out of range", display.name));
        }
        placed.push((display, monitor, stage));
    }
    if layout.compositor == Compositor::KWin {
        kwin_spans_the_placed_monitors(layout, &placed)?;
    }
    let k = match layout.mode {
        LayoutMode::Logical => placed
            .iter()
            .map(|(_, monitor, _)| monitor.scale)
            .fold(f64::INFINITY, f64::min),
        LayoutMode::Physical => 1.0,
    };
    let left = placed
        .iter()
        .map(|(_, _, s)| i64::from(s.x))
        .min()
        .unwrap_or(0);
    let top = placed
        .iter()
        .map(|(_, _, s)| i64::from(s.y))
        .min()
        .unwrap_or(0);
    let edge = |value: i64, origin: i64| ((value - origin) as f64 * k).round() as i64;
    let mut displays = Vec::with_capacity(placed.len());
    let mut mapped = Vec::with_capacity(placed.len());
    for (display, monitor, stage) in &placed {
        let (x0, x1) = (edge(i64::from(stage.x), left), edge(stage.right(), left));
        let (y0, y1) = (edge(i64::from(stage.y), top), edge(stage.bottom(), top));
        let desktop = Rect::new(
            x0 as i32,
            y0 as i32,
            (x1 - x0).max(1) as u32,
            (y1 - y0).max(1) as u32,
        );
        displays.push(DisplayInfo {
            id: display.id.clone(),
            name: display.name.clone(),
            x: desktop.x,
            y: desktop.y,
            width: desktop.width,
            height: desktop.height,
            scale: monitor.scale,
            primary: monitor.primary,
        });
        mapped.push(Mapped {
            desktop,
            stage: *stage,
        });
    }
    if !displays.iter().any(|d| d.primary) {
        displays[0].primary = true;
    }
    Ok((displays, mapped, layout.compositor))
}

/// KWin scales an absolute pointer to its workspace from 0,0
/// (`value * workspace / 65536`, not offset by the workspace's corner),
/// while the pointer map spans the box around the monitors BMuster placed.
/// The two agree only when that box starts at 0,0 and is the box around
/// every output KWin lays out.
fn kwin_spans_the_placed_monitors(
    layout: &CompositorLayout,
    placed: &[(&KmsDisplay, &PlacedMonitor, Rect)],
) -> Result<(), String> {
    let workspace = bounding(layout.monitors.iter().map(|m| match m.size {
        MonitorSize::Stage(width, height) => Rect::new(m.x, m.y, width.max(1), height.max(1)),
        MonitorSize::Mode(_) => Rect::new(m.x, m.y, 1, 1),
    }));
    if (workspace.x, workspace.y) != (0, 0) {
        return Err(format!(
            "KWin's layout starts at {},{}, not 0,0",
            workspace.x, workspace.y
        ));
    }
    if bounding(placed.iter().map(|(_, _, stage)| *stage)) != workspace {
        return Err("KWin shows a screen KMS does not".into());
    }
    Ok(())
}

#[cfg(test)]
#[path = "layout_tests.rs"]
mod tests;
