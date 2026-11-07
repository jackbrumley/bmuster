//! Golden frames shared with the browser (SPEC-DESKTOP 11.1): each message
//! type, each flag and a split tile batch, written by this crate's frame
//! code to `tests/fixtures/desktop-frames/` at the repository root, with a
//! manifest of what each one holds. The browser's `frame.test.ts` parses
//! the same bytes against the same manifest, so a format change on either
//! side breaks both. `BMUSTER_WRITE_FIXTURES=1` rewrites them after a
//! deliberate change.

use bmuster_desktop::frame::{
    cursor_position, cursor_shape, tile_batches, CursorContext, FrameInfo, Tile, TileData,
    HEADER_LEN,
};
use serde_json::{json, Value};
use std::path::PathBuf;

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../tests/fixtures/desktop-frames")
}

fn header(bytes: &[u8]) -> Value {
    let u16_at = |i: usize| u16::from_le_bytes([bytes[i], bytes[i + 1]]);
    json!({
        "type": bytes[0],
        "display": bytes[1],
        "flags": bytes[2],
        "version": bytes[3],
        "seq": u32::from_le_bytes(bytes[4..8].try_into().unwrap()),
        "pts": u64::from_le_bytes(bytes[8..16].try_into().unwrap()),
        "width": u16_at(16),
        "height": u16_at(18),
    })
}

fn tiles_payload(tiles: &[Tile]) -> Value {
    let list: Vec<Value> = tiles
        .iter()
        .map(|tile| {
            let (format, length) = match &tile.data {
                TileData::Jpeg(bytes) => (1, bytes.len()),
                TileData::Solid(_) => (3, 4),
            };
            let rgba = match &tile.data {
                TileData::Solid(rgba) => json!(rgba),
                TileData::Jpeg(_) => Value::Null,
            };
            json!({ "x": tile.x, "y": tile.y, "w": tile.w, "h": tile.h, "format": format, "length": length, "rgba": rgba })
        })
        .collect();
    json!({ "kind": "tiles", "tiles": list })
}

fn jpeg_tile(x: u16, y: u16, w: u16, h: u16) -> Tile {
    Tile {
        x,
        y,
        w,
        h,
        data: TileData::Jpeg(vec![0xFF, 0xD8, 0xFF, 0xD9]),
    }
}

fn solid_tile(x: u16, y: u16, rgba: [u8; 4]) -> Tile {
    Tile {
        x,
        y,
        w: 64,
        h: 64,
        data: TileData::Solid(rgba),
    }
}

/// (file name, bytes, expected payload)
fn golden() -> Vec<(String, Vec<u8>, Value)> {
    let mut out = Vec::new();
    // A keyframe with a new size: one JPEG edge tile and one solid tile.
    let keyframe = FrameInfo {
        display: 0,
        seq: 1,
        pts: 0,
        width: 100,
        height: 64,
        keyframe: true,
        size_changed: true,
    };
    let tiles = vec![
        solid_tile(0, 0, [10, 20, 30, 255]),
        jpeg_tile(64, 0, 36, 64),
    ];
    for bytes in tile_batches(keyframe, &tiles, 1 << 20) {
        out.push(("tile-keyframe.bin".into(), bytes, tiles_payload(&tiles)));
    }
    // A later frame split over two batches with the same seq; only the
    // second has the last-part flag. Big numbers check the 64-bit pts.
    let split = FrameInfo {
        display: 1,
        seq: 0xFFFF_FFFE,
        pts: 0x0012_3456_789A_BCDE,
        width: 1920,
        height: 1080,
        keyframe: false,
        size_changed: false,
    };
    let tiles = vec![
        solid_tile(128, 64, [255, 0, 0, 255]),
        solid_tile(192, 64, [0, 255, 0, 255]),
        solid_tile(256, 64, [0, 0, 255, 255]),
    ];
    let batches = tile_batches(split, &tiles, 40);
    assert_eq!(batches.len(), 2, "two solid tiles (34 bytes) fit in 40");
    out.push((
        "tile-split-0.bin".into(),
        batches[0].clone(),
        tiles_payload(&tiles[..2]),
    ));
    out.push((
        "tile-split-1.bin".into(),
        batches[1].clone(),
        tiles_payload(&tiles[2..]),
    ));
    let context = CursorContext {
        display: 0,
        seq: 7,
        pts: 1_500_000,
        width: 1280,
        height: 800,
    };
    let png = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    out.push((
        "cursor-shape.bin".into(),
        cursor_shape(context, 42, (3, 4), &png),
        json!({ "kind": "cursor-shape", "id": 42, "hotspotX": 3, "hotspotY": 4, "pngLength": png.len() }),
    ));
    out.push((
        "cursor-position.bin".into(),
        cursor_position(context, 42, -2, 799, true),
        json!({ "kind": "cursor-position", "id": 42, "x": -2, "y": 799, "visible": true }),
    ));
    out.push((
        "cursor-hidden.bin".into(),
        cursor_position(context, 42, 0, 0, false),
        json!({ "kind": "cursor-position", "id": 42, "x": 0, "y": 0, "visible": false }),
    ));
    out
}

#[test]
fn frame_golden_fixtures_match_the_shared_files() {
    let dir = fixtures_dir();
    let frames = golden();
    let manifest = json!({
        "headerLength": HEADER_LEN,
        "frames": frames.iter().map(|(file, bytes, payload)| json!({
            "file": file,
            "header": header(&bytes[..HEADER_LEN]),
            "payload": payload,
        })).collect::<Vec<_>>(),
    });
    let manifest_text = format!("{}\n", serde_json::to_string_pretty(&manifest).unwrap());
    if std::env::var_os("BMUSTER_WRITE_FIXTURES").is_some() {
        std::fs::create_dir_all(&dir).unwrap();
        for (file, bytes, _) in &frames {
            std::fs::write(dir.join(file), bytes).unwrap();
        }
        std::fs::write(dir.join("manifest.json"), &manifest_text).unwrap();
    }
    for (file, bytes, _) in &frames {
        let stored = std::fs::read(dir.join(file))
            .unwrap_or_else(|e| panic!("{file}: {e}; run with BMUSTER_WRITE_FIXTURES=1"));
        assert_eq!(&stored, bytes, "{file} matches the frame code");
    }
    let stored: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("manifest.json")).unwrap()).unwrap();
    assert_eq!(stored, manifest);
}
