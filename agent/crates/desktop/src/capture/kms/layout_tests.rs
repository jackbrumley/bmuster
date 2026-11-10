use super::*;
use serde_json::json;

fn kms(id: &str, name: &str, x: i32, width: u32, height: u32) -> KmsDisplay {
    KmsDisplay {
        id: id.into(),
        name: name.into(),
        card: "card1".into(),
        crtc_id: 1,
        x,
        y: 0,
        width,
        height,
        fb_x: 0,
        fb_y: 0,
        primary: x == 0,
    }
}

/// One logical monitor in a reply: x, y, scale, transform, primary and its
/// connectors.
type Logical<'a> = (i32, i32, f64, u32, bool, &'a [&'a str]);

/// A `GetCurrentState` reply as `busctl --json=short` prints it: each
/// monitor with its current mode and a smaller one, each logical monitor
/// with its place, scale, transform, primary flag and connectors.
fn reply(
    layout_mode: Option<u32>,
    monitors: &[(&str, u32, u32)],
    logical: &[Logical<'_>],
) -> String {
    let monitors: Vec<Value> = monitors
        .iter()
        .map(|(connector, width, height)| {
            json!([
                [connector, "BOE", "0x0bca", "0x00000000"],
                [
                    ["640x480@60", 640, 480, 60.0, 1.0, [1.0], {}],
                    [
                        format!("{width}x{height}@60"),
                        width,
                        height,
                        60.0,
                        1.0,
                        [1.0, 1.25, 1.5, 2.0],
                        {"is-current": {"type": "b", "data": true}}
                    ]
                ],
                {"display-name": {"type": "s", "data": "Built-in display"}}
            ])
        })
        .collect();
    let logical: Vec<Value> = logical
        .iter()
        .map(|(x, y, scale, transform, primary, connectors)| {
            let specs: Vec<Value> = connectors
                .iter()
                .map(|c| json!([c, "BOE", "0x0bca", "0x00000000"]))
                .collect();
            json!([x, y, scale, transform, primary, specs, {}])
        })
        .collect();
    let mut properties = json!({"supports-changing-layout-mode": {"type": "b", "data": false}});
    if let Some(mode) = layout_mode {
        properties["layout-mode"] = json!({"type": "u", "data": mode});
    }
    json!({
        "type": "ua((ssss)a(siiddada{sv})a{sv})a(iiduba(ssss)a{sv})a{sv}",
        "data": [7, monitors, logical, properties]
    })
    .to_string()
}

fn rects(arrangement: &Arrangement) -> Vec<(String, Rect)> {
    arrangement
        .displays
        .iter()
        .map(|d| (d.name.clone(), d.rect()))
        .collect()
}

#[test]
fn layout_parses_mutters_current_state() {
    let state = parse_current_state(&reply(
        Some(1),
        &[("eDP-1", 2880, 1800), ("HDMI-1", 1920, 1080)],
        &[
            (0, 0, 2.0, 0, true, &["eDP-1"]),
            (1440, 0, 1.0, 0, false, &["HDMI-1"]),
        ],
    ))
    .unwrap();
    assert_eq!(state.mode, LayoutMode::Logical);
    assert_eq!(
        state.monitors,
        vec![
            MutterMonitor {
                connector: "eDP-1".into(),
                mode: Some((2880, 1800))
            },
            MutterMonitor {
                connector: "HDMI-1".into(),
                mode: Some((1920, 1080))
            }
        ]
    );
    assert_eq!(state.logical[1].x, 1440);
    assert_eq!(state.logical[0].scale, 2.0);
    assert!(state.logical[0].primary);
    // Physical mode, and no layout-mode at all (logical).
    let physical = reply(
        Some(2),
        &[("DP-1", 10, 10)],
        &[(0, 0, 1.0, 0, true, &["DP-1"])],
    );
    assert_eq!(
        parse_current_state(&physical).unwrap().mode,
        LayoutMode::Physical
    );
    let absent = reply(
        None,
        &[("DP-1", 10, 10)],
        &[(0, 0, 1.0, 0, true, &["DP-1"])],
    );
    assert_eq!(
        parse_current_state(&absent).unwrap().mode,
        LayoutMode::Logical
    );
    // Not a reply at all.
    assert!(parse_current_state("Call failed: No such interface").is_err());
    assert!(parse_current_state(r#"{"type":"u","data":[1]}"#).is_err());
}

#[test]
fn layout_one_above_the_other_with_different_sizes_and_negative_offsets() {
    // A 2560x1440 monitor above and left of a 1920x1200 panel; mutter
    // places it at a negative stage position here (BMuster accepts it).
    let state = parse_current_state(&reply(
        Some(1),
        &[("eDP-1", 1920, 1200), ("DP-2", 2560, 1440)],
        &[
            (0, 0, 1.0, 0, true, &["eDP-1"]),
            (-320, -1440, 1.0, 0, false, &["DP-2"]),
        ],
    ))
    .unwrap();
    let displays = [
        kms("card1-eDP-1", "eDP-1", 0, 1920, 1200),
        kms("card1-DP-2", "DP-2", 1920, 2560, 1440),
    ];
    let arrangement = arrange(&displays, Ok(&state));
    assert_eq!(arrangement.source, LayoutSource::Mutter);
    // The desktop starts at the box's corner.
    assert_eq!(
        rects(&arrangement),
        vec![
            ("eDP-1".into(), Rect::new(320, 1440, 1920, 1200)),
            ("DP-2".into(), Rect::new(0, 0, 2560, 1440)),
        ]
    );
    assert!(arrangement.displays[0].primary);
    assert!(!arrangement.displays[1].primary);
    // The pointer maps the panel's top-left pixel below the monitor.
    assert_eq!(
        arrangement.pointer,
        PointerMap::new(vec![
            Mapped {
                desktop: Rect::new(320, 1440, 1920, 1200),
                stage: Rect::new(0, 0, 1920, 1200)
            },
            Mapped {
                desktop: Rect::new(0, 0, 2560, 1440),
                stage: Rect::new(-320, -1440, 2560, 1440)
            },
        ])
    );
}

#[test]
fn layout_fractional_and_mixed_scales_use_the_smallest_scale() {
    // A 2880x1800 panel at 1.5 (1920x1200 logical) left of a 2560x1440
    // monitor at 1.25 (2048x1152 logical): desktop units are 1/1.25 of a
    // logical pixel, so the 1.25 monitor keeps every pixel and the panel
    // is resampled to 2400x1500.
    let state = parse_current_state(&reply(
        Some(1),
        &[("eDP-1", 2880, 1800), ("HDMI-1", 2560, 1440)],
        &[
            (0, 0, 1.5, 0, true, &["eDP-1"]),
            (1920, 0, 1.25, 0, false, &["HDMI-1"]),
        ],
    ))
    .unwrap();
    let displays = [
        kms("card1-eDP-1", "eDP-1", 0, 2880, 1800),
        // The kernel calls it HDMI-A-1; mutter HDMI-1.
        kms("card1-HDMI-A-1", "HDMI-A-1", 2880, 2560, 1440),
    ];
    let arrangement = arrange(&displays, Ok(&state));
    assert_eq!(arrangement.source, LayoutSource::Mutter);
    assert_eq!(
        rects(&arrangement),
        vec![
            ("eDP-1".into(), Rect::new(0, 0, 2400, 1500)),
            ("HDMI-A-1".into(), Rect::new(2400, 0, 2560, 1440)),
        ]
    );
    assert_eq!(arrangement.displays[0].scale, 1.5);
    // Same scale everywhere: the desktop is in physical pixels.
    let state = parse_current_state(&reply(
        Some(1),
        &[("DP-1", 3840, 2160), ("DP-2", 2560, 1440)],
        &[
            (0, 0, 2.0, 0, true, &["DP-1"]),
            (1920, 0, 2.0, 0, false, &["DP-2"]),
        ],
    ))
    .unwrap();
    let displays = [
        kms("card0-DP-1", "DP-1", 0, 3840, 2160),
        kms("card0-DP-2", "DP-2", 3840, 2560, 1440),
    ];
    assert_eq!(
        rects(&arrange(&displays, Ok(&state))),
        vec![
            ("DP-1".into(), Rect::new(0, 0, 3840, 2160)),
            ("DP-2".into(), Rect::new(3840, 0, 2560, 1440)),
        ]
    );
    // The physical layout mode ignores the scale for sizes.
    let state = parse_current_state(&reply(
        Some(2),
        &[("DP-1", 3840, 2160), ("DP-2", 2560, 1440)],
        &[
            (0, 0, 2.0, 0, true, &["DP-1"]),
            (3840, 0, 1.0, 0, false, &["DP-2"]),
        ],
    ))
    .unwrap();
    assert_eq!(
        rects(&arrange(&displays, Ok(&state))),
        vec![
            ("DP-1".into(), Rect::new(0, 0, 3840, 2160)),
            ("DP-2".into(), Rect::new(3840, 0, 2560, 1440)),
        ]
    );
}

/// A real reply: Muffin (Cinnamon's mutter) on the development machine,
/// three monitors, one above the others, in the physical layout mode
/// (monitor serial numbers blanked).
#[test]
fn layout_reads_a_real_reply_with_one_monitor_above_the_others() {
    let state = parse_current_state(include_str!("layout_fixture.json")).unwrap();
    assert_eq!(state.mode, LayoutMode::Physical);
    let displays = [
        kms("card1-DisplayPort-0", "DisplayPort-0", 0, 3440, 1440),
        kms("card1-DisplayPort-1", "DisplayPort-1", 3440, 1920, 1080),
        kms("card1-DisplayPort-2", "DisplayPort-2", 5360, 1920, 1080),
    ];
    let arrangement = arrange(&displays, Ok(&state));
    assert_eq!(arrangement.source, LayoutSource::Mutter);
    assert_eq!(
        rects(&arrangement),
        vec![
            ("DisplayPort-0".into(), Rect::new(0, 1080, 3440, 1440)),
            ("DisplayPort-1".into(), Rect::new(729, 0, 1920, 1080)),
            ("DisplayPort-2".into(), Rect::new(3440, 1298, 1920, 1080)),
        ]
    );
    // The box is the 5360x2520 framebuffer the X server scans out here.
    assert_eq!(
        crate::capture::bounds_of(&arrangement.displays),
        Rect::new(0, 0, 5360, 2520)
    );
    assert!(arrangement.displays[0].primary);
}

#[test]
fn layout_maps_logical_monitors_to_connectors() {
    assert!(same_connector("HDMI-A-1", "HDMI-1"));
    assert!(same_connector("eDP-1", "eDP-1"));
    assert!(same_connector("DP-2", "dp-2"));
    assert!(!same_connector("DP-1", "eDP-1"));
    assert!(!same_connector("HDMI-A-1", "HDMI-2"));
    assert!(!same_connector("HDMI-B-1", "HDMI-1"));
}

#[test]
fn layout_falls_back_side_by_side_with_the_reason() {
    let displays = [
        kms("card1-eDP-1", "eDP-1", 0, 1920, 1200),
        kms("card1-DP-1", "DP-1", 1920, 2560, 1440),
    ];
    let side = vec![
        ("eDP-1".to_string(), Rect::new(0, 0, 1920, 1200)),
        ("DP-1".to_string(), Rect::new(1920, 0, 2560, 1440)),
    ];
    let reason = |arrangement: &Arrangement| match &arrangement.source {
        LayoutSource::SideBySide { reason } => reason.clone(),
        LayoutSource::Mutter => panic!("used mutter"),
    };
    // The bus call failed (the greeter, KDE, no session bus).
    let failed = arrange(&displays, Err("busctl exited with 1".into()));
    assert_eq!(rects(&failed), side);
    assert_eq!(reason(&failed), "busctl exited with 1");
    assert_eq!(
        failed.pointer,
        PointerMap::identity(&[Rect::new(0, 0, 1920, 1200), Rect::new(1920, 0, 2560, 1440)])
    );
    // Mutter does not list one of the connectors.
    let state = parse_current_state(&reply(
        Some(1),
        &[("eDP-1", 1920, 1200)],
        &[(0, 0, 1.0, 0, true, &["eDP-1"])],
    ))
    .unwrap();
    let missing = arrange(&displays, Ok(&state));
    assert_eq!(rects(&missing), side);
    assert_eq!(reason(&missing), "mutter does not show DP-1");
    // Mutter and KMS disagree about a mode (a change half done).
    let state = parse_current_state(&reply(
        Some(1),
        &[("eDP-1", 1920, 1200), ("DP-1", 1920, 1080)],
        &[
            (0, 0, 1.0, 0, true, &["eDP-1"]),
            (1920, 0, 1.0, 0, false, &["DP-1"]),
        ],
    ))
    .unwrap();
    assert_eq!(
        reason(&arrange(&displays, Ok(&state))),
        "mutter shows DP-1 at 1920x1080, KMS at 2560x1440"
    );
    // A rotated monitor.
    let state = parse_current_state(&reply(
        Some(1),
        &[("eDP-1", 1920, 1200), ("DP-1", 2560, 1440)],
        &[
            (0, 0, 1.0, 0, true, &["eDP-1"]),
            (1920, 0, 1.0, 1, false, &["DP-1"]),
        ],
    ))
    .unwrap();
    assert_eq!(reason(&arrange(&displays, Ok(&state))), "DP-1 is rotated");
    // Two cards, each with a DP-1: mutter's names cannot tell them apart.
    let twins = [
        kms("card0-DP-1", "DP-1", 0, 1920, 1080),
        kms("card1-DP-1", "DP-1", 1920, 1920, 1080),
    ];
    let state = parse_current_state(&reply(
        Some(1),
        &[("DP-1", 1920, 1080)],
        &[(0, 0, 1.0, 0, true, &["DP-1"])],
    ))
    .unwrap();
    assert_eq!(
        reason(&arrange(&twins, Ok(&state))),
        "two screens are called DP-1"
    );
}

#[test]
fn layout_single_display_is_unchanged_without_mutter_and_exact_with_it() {
    let displays = [kms("card1-eDP-1", "eDP-1", 0, 1920, 1200)];
    let alone = arrange(&displays, Err("no session bus".into()));
    assert_eq!(alone.displays, vec![displays[0].info()]);
    assert_eq!(
        alone.pointer,
        PointerMap::identity(&[Rect::new(0, 0, 1920, 1200)])
    );
    let state = parse_current_state(&reply(
        Some(1),
        &[("eDP-1", 1920, 1200)],
        &[(0, 0, 1.0, 0, true, &["eDP-1"])],
    ))
    .unwrap();
    let with = arrange(&displays, Ok(&state));
    assert_eq!(with.displays, vec![displays[0].info()]);
    assert_eq!(with.pointer, alone.pointer);
}
