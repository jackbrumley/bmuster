//! SPEC-DESKTOP-ALL-SCREENS K1–K4: KWin's support information, read and
//! laid out. The replies are Plasma 6's own text: two are real "Screens"
//! sections people posted from KWin 6.4.5 and 6.5.4, the rest are built
//! line for line in the same format (KWin's `Workspace::supportInformation`).

use super::super::layout::{arrange, Arrangement, LayoutSource};
use super::super::KmsDisplay;
use super::*;
use crate::capture::Rect;
use crate::input::absolute::{Mapped, PointerMap};

/// KWin 6.5.4: a 1920x1200 laptop panel at 100% right of, and 152 below
/// the top of, a 1920x1080 monitor at 75% (2560x1440 logical).
const PLASMA_6_5_SIDE_BY_SIDE: &str = "Screens
=======
Number of Screens: 2

Screen 0:
---------
Name: eDP-2
Enabled: 1
Geometry: 2560,152,1920x1200
Physical size: 344x215mm
Scale: 1
Refresh Rate: 165000
Adaptive Sync: automatic
Screen 1:
---------
Name: HDMI-A-1
Enabled: 1
Geometry: 0,0,2560x1440
Physical size: 476x268mm
Scale: 0.75
Refresh Rate: 74973
Adaptive Sync: automatic
";

/// KWin 6.4.5: four outputs, two off, a 1920x1080 monitor turned upright
/// at 75% (1440x2560 logical) right of a 2560x1440 one.
const PLASMA_6_4_ROTATED: &str = "Screens
=======
Number of Screens: 4

Screen 0:
---------
Name: HDMI-A-1
Enabled: 0
Screen 1:
---------
Name: DP-1
Enabled: 0
Screen 2:
---------
Name: DP-2
Enabled: 1
Geometry: 2560,0,1440x2560
Physical size: 597x336mm
Scale: 0.75
Refresh Rate: 60000
Adaptive Sync: incapable
Screen 3:
---------
Name: DP-3
Enabled: 1
Geometry: 0,560,2560x1440
Physical size: 597x336mm
Scale: 1
Refresh Rate: 143995
Adaptive Sync: automatic
";

/// A "Screens" section as KWin writes it, one block per output:
/// (name, x, y, width, height, scale).
fn screens(outputs: &[(&str, i32, i32, u32, u32, &str)]) -> String {
    let mut text = format!("Screens\n=======\nNumber of Screens: {}\n\n", outputs.len());
    for (index, (name, x, y, width, height, scale)) in outputs.iter().enumerate() {
        text.push_str(&format!(
            "Screen {index}:\n---------\nName: {name}\nEnabled: 1\n\
             Geometry: {x},{y},{width}x{height}\nPhysical size: 600x340mm\n\
             Scale: {scale}\nRefresh Rate: 60000\nAdaptive Sync: incapable\n"
        ));
    }
    text
}

/// The whole reply as `busctl --json=short` prints it, with the sections
/// KWin writes around "Screens".
fn reply(section: &str) -> String {
    let text = format!(
        "KWin Support Information:\nThe following information should be used when requesting \
         support on e.g. https://discuss.kde.org.\n\nVersion\n=======\nKWin version: 6.5.4\n\
         Qt Version: 6.10.1\n\nPlatform\n==========\nName: DRM\nActive: true\n\n{section}\n\
         Compositing\n===========\nCompositing is active\nCompositing Type: OpenGL\n\
         Name: not a screen\n"
    );
    serde_json::json!({"type": "s", "data": [text]}).to_string()
}

fn kms(name: &str, width: u32, height: u32) -> KmsDisplay {
    KmsDisplay {
        id: format!("card1-{name}"),
        name: name.into(),
        card: "card1".into(),
        crtc_id: 1,
        x: 0,
        y: 0,
        width,
        height,
        fb_x: 0,
        fb_y: 0,
        primary: false,
    }
}

fn rects(arrangement: &Arrangement) -> Vec<(String, Rect)> {
    arrangement
        .displays
        .iter()
        .map(|d| (d.name.clone(), d.rect()))
        .collect()
}

fn reason(arrangement: &Arrangement) -> String {
    match &arrangement.source {
        LayoutSource::SideBySide { reason } => reason.clone(),
        LayoutSource::Compositor(_) => panic!("used KWin's layout"),
    }
}

fn kwin_layout(arrangement: &Arrangement) -> bool {
    arrangement.source == LayoutSource::Compositor(Compositor::KWin)
}

/// K1: one output.
#[test]
fn kwin_parses_a_single_output() {
    let layout =
        parse_support_information(&reply(&screens(&[("eDP-1", 0, 0, 1920, 1080, "1")]))).unwrap();
    assert_eq!(
        layout,
        CompositorLayout {
            compositor: Compositor::KWin,
            mode: LayoutMode::Logical,
            monitors: vec![PlacedMonitor {
                connector: "eDP-1".into(),
                x: 0,
                y: 0,
                scale: 1.0,
                transform: 0,
                primary: false,
                size: MonitorSize::Stage(1920, 1080),
            }],
        }
    );
    // The section's lines are read, not the Compositing section's
    // "Name: not a screen" after it.
    assert_eq!(layout.monitors.len(), 1);
    let arrangement = arrange(&[kms("eDP-1", 1920, 1080)], Ok(&layout));
    assert!(kwin_layout(&arrangement));
    assert_eq!(
        rects(&arrangement),
        vec![("eDP-1".into(), Rect::new(0, 0, 1920, 1080))]
    );
    assert!(arrangement.displays[0].primary);
}

/// K1: a real Plasma 6.5 reply, two outputs side by side, one at 75%.
#[test]
fn kwin_lays_out_two_side_by_side_from_a_real_reply() {
    let layout = parse_support_information(&reply(PLASMA_6_5_SIDE_BY_SIDE)).unwrap();
    let displays = [kms("eDP-2", 1920, 1200), kms("HDMI-A-1", 1920, 1080)];
    let arrangement = arrange(&displays, Ok(&layout));
    assert!(kwin_layout(&arrangement));
    // Desktop units are 0.75 of a logical pixel: the 75% monitor keeps its
    // 1920x1080 pixels and the panel shows at 1440x900 beside it.
    assert_eq!(
        rects(&arrangement),
        vec![
            ("eDP-2".into(), Rect::new(1920, 114, 1440, 900)),
            ("HDMI-A-1".into(), Rect::new(0, 0, 1920, 1080)),
        ]
    );
    assert_eq!(
        arrangement.pointer,
        PointerMap::new(vec![
            Mapped {
                desktop: Rect::new(1920, 114, 1440, 900),
                stage: Rect::new(2560, 152, 1920, 1200)
            },
            Mapped {
                desktop: Rect::new(0, 0, 1920, 1080),
                stage: Rect::new(0, 0, 2560, 1440)
            },
        ])
    );
}

/// K1: one above the other, offset and of different sizes.
#[test]
fn kwin_lays_out_monitors_one_above_the_other() {
    let layout = parse_support_information(&reply(&screens(&[
        ("DP-1", 0, 0, 2560, 1440, "1"),
        ("eDP-1", 320, 1440, 1920, 1200, "1"),
    ])))
    .unwrap();
    let displays = [kms("eDP-1", 1920, 1200), kms("DP-1", 2560, 1440)];
    let arrangement = arrange(&displays, Ok(&layout));
    assert!(kwin_layout(&arrangement));
    assert_eq!(
        rects(&arrangement),
        vec![
            ("eDP-1".into(), Rect::new(320, 1440, 1920, 1200)),
            ("DP-1".into(), Rect::new(0, 0, 2560, 1440)),
        ]
    );
    // The first pixel of the lower panel lands on it, not on the monitor.
    let (x, y) = arrangement.pointer.to_absolute(320, 1440);
    let stage_y = f64::from(y) * 2640.0 / 65536.0;
    let stage_x = f64::from(x) * 2560.0 / 65536.0;
    assert!((1440.0..1441.0).contains(&stage_y), "{stage_y}");
    assert!((320.0..321.0).contains(&stage_x), "{stage_x}");
}

/// K1: fractional scales, 150% beside 125%, and 125% that does not divide
/// evenly (KWin rounds the logical size).
#[test]
fn kwin_lays_out_fractional_scales() {
    let layout = parse_support_information(&reply(&screens(&[
        ("eDP-1", 0, 0, 1920, 1200, "1.5"),
        ("DP-1", 1920, 0, 2048, 1152, "1.25"),
    ])))
    .unwrap();
    assert_eq!(layout.monitors[0].scale, 1.5);
    let displays = [kms("eDP-1", 2880, 1800), kms("DP-1", 2560, 1440)];
    let arrangement = arrange(&displays, Ok(&layout));
    assert!(kwin_layout(&arrangement));
    assert_eq!(
        rects(&arrangement),
        vec![
            ("eDP-1".into(), Rect::new(0, 0, 2400, 1500)),
            ("DP-1".into(), Rect::new(2400, 0, 2560, 1440)),
        ]
    );
    assert_eq!(arrangement.displays[0].scale, 1.5);
    // 1366x768 at 125% is 1092.8x614.4 logical; KWin says 1093x614.
    let layout = parse_support_information(&reply(&screens(&[
        ("LVDS-1", 0, 0, 1093, 614, "1.25"),
        ("VGA-1", 1093, 0, 1024, 768, "1"),
    ])))
    .unwrap();
    let arrangement = arrange(
        &[kms("LVDS-1", 1366, 768), kms("VGA-1", 1024, 768)],
        Ok(&layout),
    );
    assert!(kwin_layout(&arrangement));
    assert_eq!(
        rects(&arrangement),
        vec![
            ("LVDS-1".into(), Rect::new(0, 0, 1093, 614)),
            ("VGA-1".into(), Rect::new(1093, 0, 1024, 768)),
        ]
    );
}

/// K2: a turned monitor (a real Plasma 6.4 reply) falls back side by side,
/// and outputs that are off are not laid out.
#[test]
fn kwin_rotated_monitor_falls_back_and_disabled_outputs_are_skipped() {
    let layout = parse_support_information(&reply(PLASMA_6_4_ROTATED)).unwrap();
    let names: Vec<&str> = layout
        .monitors
        .iter()
        .map(|m| m.connector.as_str())
        .collect();
    assert_eq!(names, ["DP-2", "DP-3"]);
    let displays = [kms("DP-2", 1920, 1080), kms("DP-3", 2560, 1440)];
    let arrangement = arrange(&displays, Ok(&layout));
    assert_eq!(reason(&arrangement), "DP-2 is rotated");
    let side_by_side: Vec<_> = displays.iter().map(KmsDisplay::info).collect();
    assert_eq!(arrangement.displays, side_by_side);
}

/// K3: replies that do not read as expected are refused, with a reason
/// that quotes nothing from the reply.
#[test]
fn kwin_refuses_bad_replies() {
    let refused = |text: &str| parse_support_information(&reply(text)).unwrap_err();
    assert_eq!(
        parse_support_information("Call failed: No such interface").unwrap_err(),
        "supportInformation reply: expected value at line 1 column 1"
    );
    assert_eq!(
        parse_support_information(r#"{"type":"u","data":[1]}"#).unwrap_err(),
        "supportInformation reply is not text"
    );
    assert_eq!(
        refused("Version\n=======\nKWin version: 6.5.4\n"),
        "KWin's support information has no Screens section"
    );
    // Cut short: KWin counted two and described one.
    let two = screens(&[("DP-1", 0, 0, 10, 10, "1"), ("DP-2", 10, 0, 10, 10, "1")]);
    let cut = &two[..two.find("Screen 1:").unwrap()];
    assert_eq!(refused(cut), "KWin counts 2 screens and describes 1");
    let bad = |from: &str, to: &str| {
        refused(&screens(&[("DP-1", 0, 0, 1920, 1080, "1")]).replace(from, to))
    };
    for geometry in [
        "0,0,1920",
        "0,0,0x1080",
        "0,0,1920x1080,4",
        "a,0,1920x1080",
        "0,0,99999x10",
    ] {
        assert_eq!(
            bad("0,0,1920x1080", geometry),
            "KWin's screen 0 has no geometry",
            "{geometry}"
        );
    }
    assert_eq!(
        bad("Scale: 1", "Scale: big"),
        "KWin's screen 0 has no scale"
    );
    assert_eq!(
        bad("Scale: 1", "Scale: inf"),
        "KWin's screen 0 has no scale"
    );
    assert_eq!(
        bad("Name: DP-1", "Name: DP 1;rm"),
        "KWin's screen 0 has no connector name"
    );
    assert_eq!(
        bad("Enabled: 1", "Enabled: maybe"),
        "KWin's screen 0 is neither on nor off"
    );
    assert_eq!(bad("Enabled: 1", "Enabled: 0"), "KWin shows no screen");
    let many: Vec<(&str, i32, i32, u32, u32, &str)> =
        (0..65).map(|i| ("DP-1", i * 10, 0, 10, 10, "1")).collect();
    assert_eq!(refused(&screens(&many)), "KWin lists more than 64 screens");
}

/// K3: layouts that parse but cannot be used fall back side by side.
#[test]
fn kwin_layouts_that_do_not_fit_fall_back_side_by_side() {
    let displays = [kms("DP-1", 1920, 1080), kms("DP-2", 1920, 1080)];
    let layout = |outputs: &[(&str, i32, i32, u32, u32, &str)]| {
        parse_support_information(&reply(&screens(outputs))).unwrap()
    };
    let fallback = |outputs: &[(&str, i32, i32, u32, u32, &str)]| {
        reason(&arrange(&displays, Ok(&layout(outputs))))
    };
    // A scale outside 0.25–8.
    assert_eq!(
        fallback(&[
            ("DP-1", 0, 0, 19200, 10800, "0.1"),
            ("DP-2", 19200, 0, 1920, 1080, "1")
        ]),
        "DP-1 has scale 0.1"
    );
    // A size that is not the KMS mode at that scale.
    assert_eq!(
        fallback(&[
            ("DP-1", 0, 0, 1280, 720, "1"),
            ("DP-2", 1280, 0, 1920, 1080, "1")
        ]),
        "KWin shows DP-1 at 1280x720 at scale 1, KMS at 1920x1080"
    );
    // A connector KWin does not show.
    assert_eq!(
        fallback(&[("DP-1", 0, 0, 1920, 1080, "1")]),
        "KWin does not show DP-2"
    );
    // An output KMS does not show: KWin's workspace is bigger than the
    // pointer map would be.
    assert_eq!(
        fallback(&[
            ("DP-1", 0, 0, 1920, 1080, "1"),
            ("DP-2", 1920, 0, 1920, 1080, "1"),
            ("Virtual-1", 3840, 0, 1920, 1080, "1")
        ]),
        "KWin shows a screen KMS does not"
    );
    // A workspace that does not start at 0,0 (KWin's pointer would not
    // reach the left monitor).
    assert_eq!(
        fallback(&[
            ("DP-1", -1920, 0, 1920, 1080, "1"),
            ("DP-2", 0, 0, 1920, 1080, "1")
        ]),
        "KWin's layout starts at -1920,0, not 0,0"
    );
    // Placed out of range.
    assert_eq!(
        fallback(&[
            ("DP-1", 0, 0, 1920, 1080, "1"),
            ("DP-2", 70000, 0, 1920, 1080, "1")
        ]),
        "DP-2 is placed out of range"
    );
}
