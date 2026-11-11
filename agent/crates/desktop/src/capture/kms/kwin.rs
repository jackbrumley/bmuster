//! KWin's layout (SPEC-DESKTOP-ALL-SCREENS, KDE Plasma): on a Plasma
//! desktop, `org.kde.KWin.supportInformation` on `/KWin` describes every
//! output in its "Screens" section: connector name, whether it is on, its
//! geometry on the stage in logical pixels and its scale. Asked as the
//! desktop's user by [`super::compositor`].
//!
//! Plasma 6 has no other way to ask over D-Bus where the outputs are:
//! libkscreen's D-Bus backend went with Plasma 6 (KScreen reads the
//! `kde_output_device_v2` Wayland protocol in process now), and
//! `kscreen-doctor` is a Wayland client that would have to be started in
//! the person's Wayland session. The support information is KWin's own,
//! the text KDE asks for in every bug report, with the same lines since
//! Plasma 5 (`Name:`, `Enabled:`, `Geometry: x,y,wxh`, `Scale:`). Only that
//! section is read; anything else in the reply is ignored and nothing of
//! it is kept or logged. A section that does not read exactly as expected
//! is refused, and the layout falls back side by side.

use super::compositor::{name_has_owner, Call};
use super::layout::{Compositor, CompositorLayout, LayoutMode, MonitorSize, PlacedMonitor};
use serde_json::Value;

/// KWin's service.
pub const BUS_NAME: &str = "org.kde.KWin";

/// Whether KWin is on the bus.
pub const IS_THERE: Call = name_has_owner(&["s", BUS_NAME]);

/// Where the outputs are.
pub const CALL: Call = Call {
    destination: BUS_NAME,
    path: "/KWin",
    interface: BUS_NAME,
    method: "supportInformation",
    arguments: &[],
};

/// Largest width or height of an output on the stage.
const MAX_SIDE: u32 = 1 << 16;
/// Most outputs read.
const MAX_OUTPUTS: usize = 64;

/// Reads `busctl --json=short call … supportInformation` output.
pub fn parse_support_information(json: &str) -> Result<CompositorLayout, String> {
    let value: Value =
        serde_json::from_str(json).map_err(|e| format!("supportInformation reply: {e}"))?;
    let text = value
        .get("data")
        .and_then(|data| data.get(0))
        .and_then(Value::as_str)
        .ok_or("supportInformation reply is not text")?;
    parse_screens(text)
}

/// One `Screen N:` block, the lines BMuster reads.
#[derive(Default)]
struct Block<'a> {
    name: Option<&'a str>,
    enabled: Option<&'a str>,
    geometry: Option<&'a str>,
    scale: Option<&'a str>,
}

/// Whether a line underlines a section heading (`=======`).
fn underline(line: Option<&&str>) -> bool {
    line.is_some_and(|l| !l.is_empty() && l.chars().all(|c| c == '='))
}

/// Reads the "Screens" section of KWin's support information.
pub fn parse_screens(text: &str) -> Result<CompositorLayout, String> {
    let lines: Vec<&str> = text.lines().map(str::trim).collect();
    let start = (0..lines.len())
        .find(|&i| lines[i] == "Screens" && underline(lines.get(i + 1)))
        .ok_or("KWin's support information has no Screens section")?;
    let mut count: Option<usize> = None;
    let mut blocks: Vec<Block> = Vec::new();
    for (i, line) in lines.iter().enumerate().skip(start + 2) {
        if underline(lines.get(i + 1)) {
            // The next section's heading.
            break;
        }
        if line.starts_with("Screen ") && line.ends_with(':') {
            if blocks.len() == MAX_OUTPUTS {
                return Err(format!("KWin lists more than {MAX_OUTPUTS} screens"));
            }
            blocks.push(Block::default());
            continue;
        }
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        match (blocks.last_mut(), key) {
            (None, "Number of Screens") => {
                count = Some(
                    value
                        .parse()
                        .map_err(|_| "KWin's number of screens is not a number")?,
                );
            }
            (Some(block), "Name") => block.name = Some(value),
            (Some(block), "Enabled") => block.enabled = Some(value),
            (Some(block), "Geometry") => block.geometry = Some(value),
            (Some(block), "Scale") => block.scale = Some(value),
            _ => {}
        }
    }
    if let Some(count) = count {
        if count != blocks.len() {
            return Err(format!(
                "KWin counts {count} screens and describes {}",
                blocks.len()
            ));
        }
    }
    let mut monitors = Vec::new();
    for (index, block) in blocks.iter().enumerate() {
        let on = match block.enabled {
            Some("1" | "true") => true,
            Some("0" | "false") => false,
            _ => return Err(format!("KWin's screen {index} is neither on nor off")),
        };
        if on {
            monitors.push(output(index, block)?);
        }
    }
    if monitors.is_empty() {
        return Err("KWin shows no screen".into());
    }
    Ok(CompositorLayout {
        compositor: Compositor::KWin,
        mode: LayoutMode::Logical,
        monitors,
    })
}

/// A connector name as the kernel writes it: letters, digits and `-`/`_`.
fn connector_name(name: &str) -> bool {
    (1..=32).contains(&name.len())
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn output(index: usize, block: &Block) -> Result<PlacedMonitor, String> {
    let name = block
        .name
        .filter(|name| connector_name(name))
        .ok_or_else(|| format!("KWin's screen {index} has no connector name"))?;
    let geometry = block
        .geometry
        .and_then(parse_geometry)
        .ok_or_else(|| format!("KWin's screen {index} has no geometry"))?;
    let scale = block
        .scale
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|s| s.is_finite())
        .ok_or_else(|| format!("KWin's screen {index} has no scale"))?;
    let (x, y, width, height) = geometry;
    Ok(PlacedMonitor {
        connector: name.to_string(),
        x,
        y,
        scale,
        transform: 0,
        primary: false,
        size: MonitorSize::Stage(width, height),
    })
}

/// `x,y,wxh`, sizes 1 to 65536.
fn parse_geometry(text: &str) -> Option<(i32, i32, u32, u32)> {
    let mut parts = text.split(',');
    let x = parts.next()?.trim().parse().ok()?;
    let y = parts.next()?.trim().parse().ok()?;
    let (width, height) = parts.next()?.trim().split_once('x')?;
    if parts.next().is_some() {
        return None;
    }
    let side = |s: &str| s.parse::<u32>().ok().filter(|v| (1..=MAX_SIDE).contains(v));
    Some((x, y, side(width)?, side(height)?))
}

#[cfg(test)]
#[path = "kwin_tests.rs"]
mod tests;
