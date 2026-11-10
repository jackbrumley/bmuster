//! Framebuffer descriptions and plane properties, from fixtures.

use super::*;

#[test]
fn framebuffer_description() {
    let mut raw = Fb2 {
        width: 64,
        height: 64,
        pixel_format: super::super::convert::ARGB8888,
        flags: FB_MODIFIERS,
        ..Fb2::default()
    };
    raw.handles[0] = 7;
    raw.pitches[0] = 256;
    raw.modifier[0] = 0x0200_0000_0000_0001;
    let info = info_of(&raw);
    assert_eq!(info.modifier, Some(0x0200_0000_0000_0001));
    assert_eq!(info.pitches, vec![256]);
    assert!(info.has_handles);
    raw.flags = 0;
    raw.handles[0] = 0;
    let info = info_of(&raw);
    assert_eq!(info.modifier, None, "no modifier flag");
    assert!(!info.has_handles, "the kernel withheld the handles");
}

fn property(name: &str, value: u64) -> Property {
    Property {
        name: name.into(),
        value,
        enum_name: None,
    }
}

/// P1 (SPEC-CONSOLE-CAPTURE version 2).
#[test]
fn plane_from_properties() {
    let mut blend = property("pixel blend mode", 1);
    blend.enum_name = Some("Coverage".into());
    let properties = vec![
        property("type", 0),
        property("SRC_X", 0x8000),
        property("SRC_Y", 10 << 16),
        property("SRC_W", 640 << 16),
        property("SRC_H", (480 << 16) | 0x4000),
        property("CRTC_X", (-20i64) as u64),
        property("CRTC_Y", 30),
        property("CRTC_W", 1280),
        property("CRTC_H", 960),
        property("zpos", 3),
        property("alpha", 0x8000),
        property("rotation", 1 << 2),
        blend,
    ];
    let plane = super::plane_from_properties(40, 51, 130, &properties);
    assert_eq!(plane.kind, PlaneKind::Overlay);
    assert_eq!((plane.id, plane.crtc_id, plane.fb_id), (40, 51, 130));
    assert_eq!(
        plane.src,
        Some(SourceRect {
            x: 0x8000,
            y: 10 << 16,
            width: 640 << 16,
            height: (480 << 16) | 0x4000,
        })
    );
    assert_eq!(plane.crtc, Rect::new(-20, 30, 1280, 960));
    assert_eq!(plane.zpos, Some(3));
    assert_eq!(plane.alpha, Some(0x8000));
    assert_eq!(plane.blend, Some(Blend::Coverage));
    assert_eq!(plane.rotation, Some(4));

    // A driver without atomic properties: only the type, no source.
    let plane = super::plane_from_properties(31, 51, 130, &[property("type", 1)]);
    assert_eq!(plane.kind, PlaneKind::Primary);
    assert_eq!(plane.src, None);
    assert_eq!(plane.crtc, Rect::new(0, 0, 0, 0));
    assert_eq!(
        (plane.zpos, plane.alpha, plane.blend, plane.rotation),
        (None, None, None, None)
    );
    // An enum name the kernel may add later is not guessed.
    let mut odd = property("pixel blend mode", 7);
    odd.enum_name = Some("Something new".into());
    let plane = super::plane_from_properties(32, 51, 0, &[property("type", 2), odd]);
    assert_eq!((plane.kind, plane.blend), (PlaneKind::Cursor, None));
}
