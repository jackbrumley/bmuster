//! Mutter's layout (SPEC-DESKTOP-ALL-SCREENS, Layout): on a GNOME desktop,
//! `org.gnome.Mutter.DisplayConfig.GetCurrentState` lists every logical
//! monitor with its place on the stage, its scale and the connectors it
//! shows, and every monitor with its current mode. Asked as the desktop's
//! user by [`super::compositor`].

use super::compositor::{name_has_owner, Call};
use super::layout::{Compositor, CompositorLayout, LayoutMode, MonitorSize, PlacedMonitor};
use serde_json::Value;

/// Mutter's display configuration service.
pub const BUS_NAME: &str = "org.gnome.Mutter.DisplayConfig";

/// Whether mutter is on the bus.
pub const IS_THERE: Call = name_has_owner(&["s", BUS_NAME]);

/// Where the monitors are.
pub const CALL: Call = Call {
    destination: BUS_NAME,
    path: "/org/gnome/Mutter/DisplayConfig",
    interface: BUS_NAME,
    method: "GetCurrentState",
    arguments: &[],
};

/// One logical monitor: a place on the stage showing one or more monitors.
struct Logical {
    x: i32,
    y: i32,
    scale: f64,
    transform: u32,
    primary: bool,
    connectors: Vec<String>,
}

/// Reads `busctl --json=short call … GetCurrentState` output: one
/// [`PlacedMonitor`] per connector of each logical monitor, with that
/// connector's current mode.
pub fn parse_current_state(json: &str) -> Result<CompositorLayout, String> {
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
    let modes = array(field(1, "monitors")?, "monitors")?
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
    let monitors = logical
        .iter()
        .flat_map(|l| {
            l.connectors.iter().map(|connector| PlacedMonitor {
                connector: connector.clone(),
                x: l.x,
                y: l.y,
                scale: l.scale,
                transform: l.transform,
                primary: l.primary,
                size: MonitorSize::Mode(
                    modes
                        .iter()
                        .find(|(name, _)| name == connector)
                        .and_then(|(_, mode)| *mode),
                ),
            })
        })
        .collect();
    Ok(CompositorLayout {
        compositor: Compositor::Mutter,
        mode,
        monitors,
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

/// A monitor's connector and current mode.
fn monitor(value: &Value) -> Result<(String, Option<(u32, u32)>), String> {
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
    Ok((connector, mode))
}

fn logical_monitor(value: &Value) -> Result<Logical, String> {
    let int = |index: usize| {
        value
            .get(index)
            .and_then(Value::as_i64)
            .and_then(|v| i32::try_from(v).ok())
            .ok_or_else(|| format!("logical monitor field {index} is not a number"))
    };
    Ok(Logical {
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
