use super::*;

/// Where libinput puts a value on a stage `size` long (starting at
/// `start`): `value * size / 65536`, as mutter receives it.
fn libinput(value: i32, start: i32, size: u32) -> f64 {
    f64::from(start) + f64::from(value) * f64::from(size) / STEPS
}

/// The monitor whose stage rectangle holds the stage point, as mutter
/// picks it.
fn monitor_at(monitors: &[Mapped], x: f64, y: f64) -> Option<usize> {
    monitors.iter().position(|m| {
        x >= f64::from(m.stage.x)
            && x < m.stage.right() as f64
            && y >= f64::from(m.stage.y)
            && y < m.stage.bottom() as f64
    })
}

fn mapped(desktop: Rect, stage: Rect) -> Mapped {
    Mapped { desktop, stage }
}

/// Sends every desktop pixel of every monitor through the map and libinput,
/// and checks each lands on its own monitor, in the stage pixel under it.
fn every_pixel_lands(monitors: Vec<Mapped>) {
    let map = PointerMap::new(monitors.clone());
    let stage = map.stage;
    for (index, m) in monitors.iter().enumerate() {
        for y in [m.desktop.y, m.desktop.y + m.desktop.height as i32 - 1] {
            for x in m.desktop.x..m.desktop.x + m.desktop.width as i32 {
                let (ax, ay) = map.to_absolute(x, y);
                let (sx, sy) = (
                    libinput(ax, stage.x, stage.width),
                    libinput(ay, stage.y, stage.height),
                );
                assert_eq!(
                    monitor_at(&monitors, sx, sy),
                    Some(index),
                    "desktop ({x}, {y}) landed at stage ({sx}, {sy})"
                );
                // At the desktop pixel's middle, give or take one step.
                let ratio = f64::from(m.stage.width) / f64::from(m.desktop.width);
                let middle = f64::from(m.stage.x) + (f64::from(x - m.desktop.x) + 0.5) * ratio;
                let step = f64::from(stage.width) / STEPS;
                assert!(
                    sx <= middle + 1e-9 && sx > middle - step,
                    "desktop x {x}: {sx} for {middle}"
                );
            }
        }
    }
}

#[test]
fn absolute_side_by_side_edges_land_on_their_own_monitor() {
    let map = PointerMap::identity(&[Rect::new(0, 0, 1920, 1080), Rect::new(1920, 0, 2560, 1440)]);
    // The last pixel of the left monitor and the first of the right.
    let (left, _) = map.to_absolute(1919, 0);
    let (right, _) = map.to_absolute(1920, 0);
    assert!(libinput(left, 0, 4480) < 1920.0);
    assert!(libinput(right, 0, 4480) >= 1920.0);
    every_pixel_lands(vec![
        mapped(Rect::new(0, 0, 1920, 1080), Rect::new(0, 0, 1920, 1080)),
        mapped(
            Rect::new(1920, 0, 2560, 1440),
            Rect::new(1920, 0, 2560, 1440),
        ),
    ]);
}

#[test]
fn absolute_one_above_the_other_with_different_widths() {
    // A 2560 monitor above a 1920 laptop panel, centred over it; the
    // desktop starts at a negative x.
    every_pixel_lands(vec![
        mapped(
            Rect::new(-320, -1440, 2560, 1440),
            Rect::new(0, 0, 2560, 1440),
        ),
        mapped(
            Rect::new(0, 0, 1920, 1200),
            Rect::new(320, 1440, 1920, 1200),
        ),
    ]);
}

#[test]
fn absolute_maps_scaled_monitors_through_their_logical_size() {
    // A scale-2 panel (2880x1800, 1440x900 logical) beside a scale-1
    // monitor: the desktop is in logical pixels (the smallest scale).
    every_pixel_lands(vec![
        mapped(Rect::new(0, 0, 1440, 900), Rect::new(0, 0, 1440, 900)),
        mapped(
            Rect::new(1440, 0, 1920, 1080),
            Rect::new(1440, 0, 1920, 1080),
        ),
    ]);
    // Two scale-2 monitors: the desktop is in physical pixels, twice the
    // stage.
    every_pixel_lands(vec![
        mapped(Rect::new(0, 0, 2560, 1440), Rect::new(0, 0, 1280, 720)),
        mapped(
            Rect::new(2560, 0, 3840, 2160),
            Rect::new(1280, 0, 1920, 1080),
        ),
    ]);
    // Fractional 1.25 and 1.5: the desktop at 1.25, the 1.5 monitor
    // squeezed.
    every_pixel_lands(vec![
        mapped(Rect::new(0, 0, 2560, 1600), Rect::new(0, 0, 2048, 1280)),
        mapped(
            Rect::new(2560, 0, 3200, 1800),
            Rect::new(2048, 0, 2560, 1440),
        ),
    ]);
}

#[test]
fn absolute_a_point_between_monitors_goes_to_the_nearest() {
    let map = PointerMap::identity(&[Rect::new(0, 0, 100, 100), Rect::new(100, 0, 50, 50)]);
    // Just under the small monitor: nothing there, so its bottom row.
    let (ax, ay) = map.to_absolute(120, 60);
    assert_eq!(
        monitor_at(&map.monitors, libinput(ax, 0, 150), libinput(ay, 0, 100)),
        Some(1)
    );
    assert_eq!(libinput(ay, 0, 100).floor(), 49.0);
    // Far outside: clamped to the nearest monitor's edge pixel.
    assert_eq!(map.to_absolute(-50, -50), map.to_absolute(0, 0));
    assert_eq!(map.to_absolute(10_000, 10), map.to_absolute(149, 10));
}

#[test]
fn absolute_axis_lands_inside_the_pixel_whether_windows_rounds_or_truncates() {
    let width = 5760.0;
    for x in [0, 1, 1919, 1920, 3839, 3840, 5759] {
        let value = axis(f64::from(x) + 0.25, width);
        let landed = f64::from(value) * width / STEPS;
        assert_eq!(landed.floor() as i32, x, "truncated {x}");
        assert_eq!(landed.round() as i32, x, "rounded {x}");
    }
    assert_eq!(axis(-3.0, 100.0), 0);
    assert_eq!(axis(200.0, 100.0), 65535);
    assert_eq!(axis(1.0, 0.0), 0);
}
