//! Where the KMS displays really are (SPEC-DESKTOP-ALL-SCREENS, Layout).
//!
//! KMS knows each screen's mode but not how the compositor arranges them,
//! so the helper lays them out side by side. On a GNOME desktop mutter
//! knows: `org.gnome.Mutter.DisplayConfig.GetCurrentState` lists every
//! logical monitor with its place on the stage, its scale and the
//! connectors it shows. [`arrange`] turns that into BMuster's desktop:
//!
//! - **Stage**: mutter's layout. In the logical layout mode (Wayland's
//!   default) a monitor of mode `w × h` at scale `s` covers
//!   `round(w / s) × round(h / s)` stage pixels; in the physical mode, `w × h`.
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
//! connector mutter does not list, a mode that differs, a rotated monitor)
//! falls back to the side-by-side layout, with the reason.

use super::KmsDisplay;
use crate::capture::{DisplayInfo, Rect};
use crate::input::absolute::{Mapped, PointerMap};
use serde_json::Value;

/// How mutter sizes logical monitors (`layout-mode`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LayoutMode {
    /// Stage pixels are logical: a monitor's size is its mode over its scale.
    Logical,
    /// Stage pixels are physical: a monitor's size is its mode.
    Physical,
}

/// One physical monitor and its current mode.
#[derive(Debug, Clone, PartialEq)]
pub struct MutterMonitor {
    /// The connector, as mutter names it (`eDP-1`, `HDMI-1`, `DP-2`).
    pub connector: String,
    pub mode: Option<(u32, u32)>,
}

/// One logical monitor: a place on the stage showing one or more monitors.
#[derive(Debug, Clone, PartialEq)]
pub struct LogicalMonitor {
    pub x: i32,
    pub y: i32,
    pub scale: f64,
    /// 0 is normal; 1–3 rotate, 4–7 flip.
    pub transform: u32,
    pub primary: bool,
    pub connectors: Vec<String>,
}

/// What `GetCurrentState` said, the parts BMuster uses.
#[derive(Debug, Clone, PartialEq)]
pub struct MutterState {
    pub mode: LayoutMode,
    pub monitors: Vec<MutterMonitor>,
    pub logical: Vec<LogicalMonitor>,
}

/// Where the layout came from, for the log and the spec's "layout source".
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LayoutSource {
    Mutter,
    /// The helper's side-by-side order, and why mutter's was not used.
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

/// Lays `kms` out by mutter's state, or side by side when there is none or
/// it does not fit (`mutter` holds the reason then).
pub fn arrange(kms: &[KmsDisplay], mutter: Result<&MutterState, String>) -> Arrangement {
    match mutter.and_then(|state| from_mutter(kms, state)) {
        Ok((displays, mapped)) => Arrangement {
            displays,
            pointer: PointerMap::new(mapped),
            source: LayoutSource::Mutter,
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

/// Whether a KMS connector name (the kernel's) is mutter's `name`. Mutter
/// calls HDMI type A plain `HDMI`.
pub fn same_connector(kms: &str, mutter: &str) -> bool {
    plain(kms) == plain(mutter)
}

/// A connector name in lower case, with `HDMI-A-` written `HDMI-`.
fn plain(name: &str) -> String {
    let lower = name.to_ascii_lowercase();
    match lower.strip_prefix("hdmi-a-") {
        Some(number) => format!("hdmi-{number}"),
        None => lower,
    }
}

fn from_mutter(
    kms: &[KmsDisplay],
    state: &MutterState,
) -> Result<(Vec<DisplayInfo>, Vec<Mapped>), String> {
    if kms.is_empty() {
        return Err("there are no displays".into());
    }
    let mut placed: Vec<(&KmsDisplay, &LogicalMonitor, Rect)> = Vec::new();
    for display in kms {
        // Mutter names connectors without the card: two cards with a DP-1
        // each cannot be told apart.
        let twins = kms
            .iter()
            .filter(|other| same_connector(&other.name, &display.name))
            .count();
        if twins > 1 {
            return Err(format!("two screens are called {}", display.name));
        }
        let logical = state
            .logical
            .iter()
            .find(|l| {
                l.connectors
                    .iter()
                    .any(|c| same_connector(&display.name, c))
            })
            .ok_or_else(|| format!("mutter does not show {}", display.name))?;
        if logical.transform != 0 {
            return Err(format!("{} is rotated", display.name));
        }
        if !(logical.scale.is_finite() && (0.25..=8.0).contains(&logical.scale)) {
            return Err(format!("{} has scale {}", display.name, logical.scale));
        }
        let monitor = state
            .monitors
            .iter()
            .find(|m| same_connector(&display.name, &m.connector))
            .ok_or_else(|| format!("mutter lists no monitor {}", display.name))?;
        let (width, height) = monitor
            .mode
            .ok_or_else(|| format!("mutter has no mode for {}", display.name))?;
        if (width, height) != (display.width, display.height) {
            return Err(format!(
                "mutter shows {} at {width}x{height}, KMS at {}x{}",
                display.name, display.width, display.height
            ));
        }
        let (stage_width, stage_height) = match state.mode {
            LayoutMode::Logical => (
                (f64::from(width) / logical.scale).round() as u32,
                (f64::from(height) / logical.scale).round() as u32,
            ),
            LayoutMode::Physical => (width, height),
        };
        let stage = Rect::new(
            logical.x,
            logical.y,
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
        placed.push((display, logical, stage));
    }
    let k = match state.mode {
        LayoutMode::Logical => placed
            .iter()
            .map(|(_, logical, _)| logical.scale)
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
    for (display, logical, stage) in &placed {
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
            scale: logical.scale,
            primary: logical.primary,
        });
        mapped.push(Mapped {
            desktop,
            stage: *stage,
        });
    }
    if !displays.iter().any(|d| d.primary) {
        displays[0].primary = true;
    }
    Ok((displays, mapped))
}

/// Reads `busctl --json=short call … GetCurrentState` output.
pub fn parse_current_state(json: &str) -> Result<MutterState, String> {
    let value: Value =
        serde_json::from_str(json).map_err(|e| format!("GetCurrentState reply: {e}"))?;
    let data = value
        .get("data")
        .and_then(Value::as_array)
        .ok_or("GetCurrentState reply has no data")?;
    let field = |index: usize, what: &str| {
        data.get(index)
            .ok_or_else(|| format!("GetCurrentState reply has no {what}"))
    };
    let monitors = array(field(1, "monitors")?, "monitors")?
        .iter()
        .map(monitor)
        .collect::<Result<Vec<_>, _>>()?;
    let logical = array(field(2, "logical monitors")?, "logical monitors")?
        .iter()
        .map(logical_monitor)
        .collect::<Result<Vec<_>, _>>()?;
    // Absent means the mode cannot change, and mutter then lays out in
    // logical pixels.
    let mode = match variant(field(3, "properties")?, "layout-mode").and_then(Value::as_u64) {
        Some(2) => LayoutMode::Physical,
        _ => LayoutMode::Logical,
    };
    Ok(MutterState {
        mode,
        monitors,
        logical,
    })
}

fn array<'a>(value: &'a Value, what: &str) -> Result<&'a Vec<Value>, String> {
    value
        .as_array()
        .ok_or_else(|| format!("GetCurrentState {what} is not a list"))
}

/// A `v` in an `a{sv}`, as busctl writes it: `{"type": …, "data": …}`.
fn variant<'a>(properties: &'a Value, key: &str) -> Option<&'a Value> {
    properties.get(key)?.get("data")
}

fn connector_of(spec: &Value) -> Result<String, String> {
    spec.get(0)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "GetCurrentState monitor has no connector".to_string())
}

fn monitor(value: &Value) -> Result<MutterMonitor, String> {
    let connector = connector_of(value.get(0).ok_or("monitor without a spec")?)?;
    let modes = array(value.get(1).ok_or("monitor without modes")?, "modes")?;
    let mode = modes.iter().find_map(|mode| {
        let current = mode
            .get(6)
            .and_then(|props| variant(props, "is-current"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let size = |index: usize| {
            mode.get(index)?
                .as_u64()
                .and_then(|v| u32::try_from(v).ok())
        };
        current.then(|| size(1).zip(size(2))).flatten()
    });
    Ok(MutterMonitor { connector, mode })
}

fn logical_monitor(value: &Value) -> Result<LogicalMonitor, String> {
    let int = |index: usize| {
        value
            .get(index)
            .and_then(Value::as_i64)
            .and_then(|v| i32::try_from(v).ok())
            .ok_or_else(|| format!("logical monitor field {index} is not a number"))
    };
    Ok(LogicalMonitor {
        x: int(0)?,
        y: int(1)?,
        scale: value
            .get(2)
            .and_then(Value::as_f64)
            .ok_or("logical monitor has no scale")?,
        transform: value
            .get(3)
            .and_then(Value::as_u64)
            .and_then(|v| u32::try_from(v).ok())
            .ok_or("logical monitor has no transform")?,
        primary: value.get(4).and_then(Value::as_bool).unwrap_or(false),
        connectors: array(
            value.get(5).ok_or("logical monitor without monitors")?,
            "monitors",
        )?
        .iter()
        .map(connector_of)
        .collect::<Result<Vec<_>, _>>()?,
    })
}

#[cfg(test)]
#[path = "layout_tests.rs"]
mod tests;
