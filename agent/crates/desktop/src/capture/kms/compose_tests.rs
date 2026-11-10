//! Composition with fake plane sets (SPEC-CONSOLE-CAPTURE version 2,
//! P2–P5): no card or GPU is involved.

use super::*;
use crate::capture::kms::Mode;

fn crtc(fb_id: u32, x: u32) -> Crtc {
    Crtc {
        id: 51,
        fb_id,
        x,
        y: 0,
        mode: Some(Mode {
            width: 1920,
            height: 1200,
            refresh: 60,
        }),
    }
}

fn plane(id: u32, kind: PlaneKind, fb_id: u32, zpos: Option<u64>) -> Plane {
    Plane {
        id,
        kind,
        crtc_id: 51,
        fb_id,
        crtc: Rect::new(0, 0, 1920, 1200),
        src: Some(SourceRect::pixels(0, 0, 1920, 1200)),
        zpos,
        alpha: None,
        blend: None,
        rotation: None,
    }
}

fn layer(src: SourceRect, dst: Rect) -> Layer {
    Layer {
        plane: 40,
        fb_id: 140,
        src,
        dst,
        alpha: OPAQUE,
        blend: Blend::Premultiplied,
        rotation: ROTATE_0,
    }
}

/// P2.
#[test]
fn layers_in_zpos_order() {
    let mut elsewhere = plane(45, PlaneKind::Overlay, 145, Some(0));
    elsewhere.crtc_id = 71;
    let planes = vec![
        plane(40, PlaneKind::Overlay, 140, Some(2)),
        plane(44, PlaneKind::Overlay, 144, None),
        plane(32, PlaneKind::Cursor, 132, Some(9)),
        plane(41, PlaneKind::Overlay, 141, Some(1)),
        plane(31, PlaneKind::Primary, 131, Some(1)),
        plane(43, PlaneKind::Overlay, 0, Some(3)),
        elsewhere,
    ];
    let order: Vec<_> = layers(&crtc(131, 0), &planes)
        .iter()
        .map(|l| l.plane)
        .collect();
    // zpos 1: the primary below the overlay; an overlay without zpos
    // counts as 1 and sorts by id. The cursor, the plane without a
    // framebuffer and the other CRTC's plane are not drawn.
    assert_eq!(order, vec![31, 41, 44, 40]);
    let first = layers(&crtc(131, 0), &planes)[0];
    assert_eq!(
        (first.alpha, first.blend, first.rotation),
        (OPAQUE, Blend::Premultiplied, ROTATE_0),
        "missing properties take the kernel's defaults"
    );

    // No atomic properties: the legacy framebuffer from the CRTC's offset.
    let mut legacy = plane(31, PlaneKind::Primary, 120, None);
    legacy.src = None;
    let mut overlay = plane(40, PlaneKind::Overlay, 140, None);
    overlay.src = None;
    let found = layers(&crtc(120, 1920), &[legacy.clone(), overlay]);
    assert_eq!(
        found,
        vec![Layer {
            plane: 31,
            fb_id: 120,
            src: SourceRect::pixels(1920, 0, 1920, 1200),
            dst: Rect::new(0, 0, 1920, 1200),
            alpha: OPAQUE,
            blend: Blend::Premultiplied,
            rotation: ROTATE_0,
        }]
    );
    // No planes listed at all (no universal planes): the CRTC alone.
    assert_eq!(layers(&crtc(120, 0), &[])[0].plane, 0);
    // Nothing scanned out, or the CRTC off.
    assert!(layers(&crtc(0, 0), &[]).is_empty());
    let mut off = crtc(120, 0);
    off.mode = None;
    assert!(layers(&off, &[legacy]).is_empty());
}

/// P3.
#[test]
fn placement_maths() {
    // 16.16 source starting half a pixel in.
    let mut half = layer(
        SourceRect {
            x: (10 << 16) | 0x8000,
            y: 20 << 16,
            width: 100 << 16,
            height: 50 << 16,
        },
        Rect::new(0, 0, 100, 50),
    );
    let placement = Placement::new(&half, 300, 200).unwrap();
    assert_eq!(placement.source(0.0, 0.0), (10.5, 20.0));
    assert_eq!(placement.source(1.0, 1.0), (110.5, 70.0));
    assert_eq!(placement.source_box(), Rect::new(10, 20, 101, 50));
    assert!(placement.scaled(), "a half-pixel start filters");

    // A 960x600 buffer scaled up to the whole 1920x1200 CRTC (the
    // stretched LocalSend window).
    let up = layer(
        SourceRect::pixels(0, 0, 960, 600),
        Rect::new(0, 0, 1920, 1200),
    );
    let placement = Placement::new(&up, 960, 600).unwrap();
    assert_eq!(placement.source(0.5, 0.5), (480.0, 300.0));
    assert!(placement.scaled());
    assert!(!placement.is_copy(1920, 1200));
    assert_eq!(
        placement.corners(),
        [(0.0, 0.0), (1.0, 0.0), (0.0, 1.0), (1.0, 1.0)]
    );

    // On the GPU: the quad's corners in clip space, sampling the whole
    // buffer; the top of the frame is clip-space -1 (read back first).
    let (positions, texture) = placement.quad(1920, 1200);
    assert_eq!(positions, [-1.0, -1.0, 1.0, -1.0, -1.0, 1.0, 1.0, 1.0]);
    assert_eq!(texture, [0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 1.0]);
    let quarter = layer(
        SourceRect::pixels(480, 300, 480, 300),
        Rect::new(960, 0, 960, 600),
    );
    let (positions, texture) = Placement::new(&quarter, 960, 600).unwrap().quad(1920, 1200);
    assert_eq!(positions, [0.0, -1.0, 1.0, -1.0, 0.0, 0.0, 1.0, 0.0]);
    assert_eq!(texture, [0.5, 0.5, 1.0, 0.5, 0.5, 1.0, 1.0, 1.0]);

    // Clipping to the CRTC: a window hanging off the bottom left.
    let off_edge = layer(
        SourceRect::pixels(0, 0, 400, 300),
        Rect::new(-100, 1100, 400, 300),
    );
    let placement = Placement::new(&off_edge, 400, 300).unwrap();
    assert_eq!(
        placement.visible(1920, 1200),
        Some(Rect::new(0, 1100, 300, 100))
    );
    assert!(!placement.scaled());
    let gone = layer(SourceRect::pixels(0, 0, 10, 10), Rect::new(1920, 0, 10, 10));
    assert_eq!(
        Placement::new(&gone, 10, 10).unwrap().visible(1920, 1200),
        None
    );

    // Rotation (counter clockwise) and reflection: which source corner
    // shows at the destination's top left.
    let mut turned = layer(
        SourceRect::pixels(0, 0, 600, 960),
        Rect::new(0, 0, 960, 600),
    );
    for (rotation, top_left) in [
        (ROTATE_0, (0.0, 0.0)),
        (ROTATE_90, (600.0, 0.0)),
        (ROTATE_180, (600.0, 960.0)),
        (ROTATE_270, (0.0, 960.0)),
        (ROTATE_0 | REFLECT_X, (600.0, 0.0)),
        (ROTATE_0 | REFLECT_Y, (0.0, 960.0)),
        (ROTATE_90 | REFLECT_X, (0.0, 0.0)),
    ] {
        turned.rotation = rotation;
        let placement = Placement::new(&turned, 600, 960).unwrap();
        assert_eq!(
            placement.source(0.0, 0.0),
            top_left,
            "rotation {rotation:#x}"
        );
    }
    // A quarter turn swaps the sides, so 600x960 onto 960x600 is one to one.
    turned.rotation = ROTATE_90;
    assert!(!Placement::new(&turned, 600, 960).unwrap().scaled());
    turned.rotation = ROTATE_0;
    assert!(Placement::new(&turned, 600, 960).unwrap().scaled());

    // A plain copy only when nothing changes the pixels.
    let copy = layer(
        SourceRect::pixels(1920, 0, 1920, 1200),
        Rect::new(0, 0, 1920, 1200),
    );
    assert!(Placement::new(&copy, 3840, 1200)
        .unwrap()
        .is_copy(1920, 1200));
    let mut faded = copy;
    faded.alpha = 0x8000;
    assert!(!Placement::new(&faded, 3840, 1200)
        .unwrap()
        .is_copy(1920, 1200));
    let mut coverage = copy;
    coverage.blend = Blend::Coverage;
    assert!(!Placement::new(&coverage, 3840, 1200)
        .unwrap()
        .is_copy(1920, 1200));

    // Refusals: a source past the framebuffer, empty rectangles.
    let error = Placement::new(&copy, 1920, 1200).unwrap_err();
    assert!(error.contains("outside"), "{error}");
    half.src.height = 0;
    assert!(Placement::new(&half, 300, 200).is_err());
    assert!(Placement::new(
        &layer(SourceRect::pixels(0, 0, 1, 1), Rect::new(0, 0, 0, 1)),
        1,
        1
    )
    .is_err());
}

/// A `width` × `height` frame of one BGRA colour.
fn solid(width: u32, height: u32, bgra: [u8; 4]) -> Frame {
    let mut frame = Frame::new(width, height);
    for pixel in frame.data.chunks_exact_mut(4) {
        pixel.copy_from_slice(&bgra);
    }
    frame
}

fn cpu(layer_: Layer, buffer: (u32, u32), bgra: [u8; 4], alpha_channel: bool) -> CpuLayer {
    let placement = Placement::new(&layer_, buffer.0, buffer.1).unwrap();
    let source = placement.source_box();
    CpuLayer {
        placement,
        pixels: solid(source.width, source.height, bgra),
        alpha_channel,
    }
}

fn pixel(frame: &Frame, x: u32, y: u32) -> [u8; 3] {
    let row = frame.row(y);
    let at = x as usize * 4;
    [row[at], row[at + 1], row[at + 2]]
}

/// P4.
#[test]
fn cpu_composition() {
    const RED: [u8; 4] = [0, 0, 0xFF, 0xFF];
    const GREEN: [u8; 4] = [0, 0xFF, 0, 0xFF];
    // A 2x2 primary in the middle of a 4x2 CRTC leaves black either side.
    let primary = layer(SourceRect::pixels(0, 0, 2, 2), Rect::new(1, 0, 2, 2));
    let frame = compose_cpu(4, 2, vec![cpu(primary, (2, 2), RED, false)]);
    let row: Vec<_> = (0..4).map(|x| pixel(&frame, x, 1)).collect();
    assert_eq!(row, vec![[0, 0, 0], [0, 0, 0xFF], [0, 0, 0xFF], [0, 0, 0]]);

    // A 1x1 overlay scaled to cover the top row, over the primary.
    let overlay = layer(SourceRect::pixels(0, 0, 1, 1), Rect::new(0, 0, 4, 1));
    let frame = compose_cpu(
        4,
        2,
        vec![
            cpu(primary, (2, 2), RED, false),
            cpu(overlay, (1, 1), GREEN, true),
        ],
    );
    assert!((0..4).all(|x| pixel(&frame, x, 0) == [0, 0xFF, 0]));
    assert_eq!(pixel(&frame, 1, 1), [0, 0, 0xFF]);

    // A scaled source samples the nearest pixel: a 2x1 red and green buffer
    // stretched over 4x1.
    let mut halves = Frame::new(2, 1);
    halves
        .data
        .copy_from_slice(&[0, 0, 0xFF, 0xFF, 0, 0xFF, 0, 0xFF]);
    let wide = layer(SourceRect::pixels(0, 0, 2, 1), Rect::new(0, 0, 4, 1));
    let frame = compose_cpu(
        4,
        1,
        vec![CpuLayer {
            placement: Placement::new(&wide, 2, 1).unwrap(),
            pixels: halves,
            alpha_channel: false,
        }],
    );
    let row: Vec<_> = (0..4).map(|x| pixel(&frame, x, 0)).collect();
    assert_eq!(
        row,
        vec![[0, 0, 0xFF], [0, 0, 0xFF], [0, 0xFF, 0], [0, 0xFF, 0]]
    );

    // Alpha: half-transparent white over a white or black primary.
    let whole = layer(SourceRect::pixels(0, 0, 1, 1), Rect::new(0, 0, 1, 1));
    let over = |below: [u8; 4], top: Layer, bgra: [u8; 4], alpha_channel: bool| {
        let frame = compose_cpu(
            1,
            1,
            vec![
                cpu(whole, (1, 1), below, false),
                cpu(top, (1, 1), bgra, alpha_channel),
            ],
        );
        pixel(&frame, 0, 0)[0]
    };
    const BLACK: [u8; 4] = [0, 0, 0, 0xFF];
    const WHITE: [u8; 4] = [0xFF, 0xFF, 0xFF, 0xFF];
    // Pre-multiplied: colour 0x80 at alpha 0x80 is half white.
    assert_eq!(over(BLACK, whole, [0x80, 0x80, 0x80, 0x80], true), 0x80);
    assert_eq!(over(WHITE, whole, [0x80, 0x80, 0x80, 0x80], true), 0xFF);
    // Coverage: straight white at alpha 0x80 is multiplied in.
    let mut coverage = whole;
    coverage.blend = Blend::Coverage;
    assert_eq!(over(BLACK, coverage, [0xFF, 0xFF, 0xFF, 0x80], true), 0x80);
    // None: the pixel's alpha is ignored, the plane alpha counts.
    let mut none = whole;
    none.blend = Blend::None;
    none.alpha = 0x8000;
    assert_eq!(over(BLACK, none, [0xFF, 0xFF, 0xFF, 0x00], true), 0x80);
    // Plane alpha on a pre-multiplied plane.
    let mut faded = whole;
    faded.alpha = 0x8000;
    assert_eq!(over(BLACK, faded, WHITE, true), 0x80);
    // XRGB's fourth byte is padding, whatever it holds: opaque.
    assert_eq!(over(BLACK, whole, [0xFF, 0xFF, 0xFF, 0x00], false), 0xFF);
    // A fully transparent pre-multiplied pixel leaves what is below.
    assert_eq!(over(WHITE, whole, [0, 0, 0, 0], true), 0xFF);

    // The lone primary covering the CRTC one to one is the frame itself,
    // its fourth byte untouched (version 1's copy).
    let frame = compose_cpu(1, 1, vec![cpu(whole, (1, 1), [1, 2, 3, 0x42], false)]);
    assert_eq!(frame.data, vec![1, 2, 3, 0x42]);
    // No layers: black.
    assert_eq!(compose_cpu(2, 1, Vec::new()).data, vec![0; 8]);
}

fn info(format: u32) -> FramebufferInfo {
    FramebufferInfo {
        width: 1920,
        height: 1200,
        format,
        modifier: Some(0x0100_0000_0000_0002),
        pitches: vec![7680],
        has_handles: true,
    }
}

/// P5.
#[test]
fn plane_set_changes_are_logged_once() {
    use super::super::convert::{ARGB8888, XRGB8888};
    let mut watch = PlaneWatch::default();
    let primary = plane(31, PlaneKind::Primary, 131, Some(0));
    let mut overlay = plane(40, PlaneKind::Overlay, 140, Some(1));
    overlay.src = Some(SourceRect {
        x: 0,
        y: 0,
        width: 960 << 16,
        height: (600 << 16) | 0x8000,
    });
    overlay.crtc = Rect::new(-10, 20, 480, 300);
    overlay.alpha = Some(0xFFFF);
    overlay.blend = Some(Blend::Coverage);
    overlay.rotation = Some(ROTATE_0);
    let mut cursor = plane(32, PlaneKind::Cursor, 132, None);
    cursor.crtc = Rect::new(500, 400, 64, 64);
    let set = vec![
        (primary.clone(), Some(info(XRGB8888))),
        (overlay.clone(), Some(info(ARGB8888))),
        (cursor.clone(), None),
    ];
    let lines = watch
        .update("card1-eDP-1", &set)
        .expect("the first capture logs");
    assert_eq!(lines.len(), 3, "one line per plane");
    assert_eq!(
        lines[1],
        "KMS display card1-eDP-1: plane 40 overlay fb 140 AR24 1920x1200 modifier 0x0100000000000002, src 960x600.5000+0+0, crtc 480x300-10+20, zpos 1, alpha 0xffff, blend coverage, rotation rotate-0"
    );
    assert!(
        lines[2].contains("plane 32 cursor fb 132 (not readable)"),
        "{}",
        lines[2]
    );
    assert!(
        lines[2].contains("alpha -, blend -, rotation -"),
        "{}",
        lines[2]
    );
    assert_eq!(watch.update("card1-eDP-1", &set), None, "nothing changed");

    // The compositor flips to another framebuffer and the pointer moves:
    // not a change.
    let mut flipped = set.clone();
    flipped[0].0.fb_id = 133;
    flipped[1].0.fb_id = 141;
    flipped[2].0.crtc.x = 10;
    assert_eq!(watch.update("card1-eDP-1", &flipped), None);
    // The cursor hides: still not a change.
    assert_eq!(watch.update("card1-eDP-1", &flipped[..2]), None);
    // The window moves off the overlay plane: a change.
    let lines = watch
        .update("card1-eDP-1", &flipped[..1])
        .expect("a change");
    assert_eq!(lines.len(), 1);
    assert!(
        lines[0].contains("plane 31 primary fb 133 XR24"),
        "{}",
        lines[0]
    );
    // Each display is watched on its own.
    assert!(watch.update("card1-HDMI-A-1", &flipped[..1]).is_some());
    watch.retain(|display| display == "card1-HDMI-A-1");
    assert!(watch.update("card1-eDP-1", &flipped[..1]).is_some());
    // Unknown rotation bits are shown as a number.
    let mut odd = primary;
    odd.rotation = Some(0x40);
    assert!(describe(&odd, None).ends_with("rotation 0x40"));
}
