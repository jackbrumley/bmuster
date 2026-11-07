//! Tile encoder timing for one 1920×1080 frame: a full keyframe, and a
//! frame where 5% of the screen changed.
//!
//! Run with `cargo bench -p bmuster-desktop --bench tiles`. The picture is
//! desktop-like: a gradient wallpaper, flat window chrome and text-like
//! detail, so solid tiles and JPEG tiles both occur.

use bmuster_desktop::capture::{Damage, Frame, Rect};
use bmuster_desktop::encode::tiles::TileEncoder;
use std::time::{Duration, Instant};

const WIDTH: u32 = 1920;
const HEIGHT: u32 = 1080;
const RUNS: usize = 30;

/// A small deterministic random number generator (xorshift).
struct Noise(u32);

impl Noise {
    fn next(&mut self) -> u32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 17;
        self.0 ^= self.0 << 5;
        self.0
    }
}

fn put(frame: &mut Frame, x: u32, y: u32, bgr: [u8; 3]) {
    frame.row_mut(y)[x as usize * 4..x as usize * 4 + 4]
        .copy_from_slice(&[bgr[0], bgr[1], bgr[2], 0]);
}

/// Black "glyphs" on white lines, like a page of text.
fn text(frame: &mut Frame, area: Rect, noise: &mut Noise) {
    frame.fill(area, [255, 255, 255, 0]);
    for line in (area.y as u32..area.y as u32 + area.height).step_by(18) {
        for y in line + 4..(line + 14).min(area.y as u32 + area.height) {
            for x in area.x as u32 + 8..area.x as u32 + area.width - 8 {
                if noise.next().is_multiple_of(3) {
                    put(frame, x, y, [30, 30, 30]);
                }
            }
        }
    }
}

fn desktop() -> Frame {
    let mut frame = Frame::new(WIDTH, HEIGHT);
    for y in 0..HEIGHT {
        for x in 0..WIDTH {
            put(&mut frame, x, y, [(x / 8) as u8, (y / 5) as u8, 120]);
        }
    }
    let mut noise = Noise(0x1234_5678);
    // A taskbar, two windows with title bars and text.
    frame.fill(Rect::new(0, 1040, WIDTH, 40), [40, 40, 40, 0]);
    for window in [Rect::new(80, 60, 900, 700), Rect::new(1000, 200, 820, 600)] {
        frame.fill(
            Rect::new(window.x, window.y, window.width, 32),
            [200, 120, 60, 0],
        );
        text(
            &mut frame,
            Rect::new(window.x, window.y + 32, window.width, window.height - 32),
            &mut noise,
        );
    }
    frame
}

fn median(mut times: Vec<Duration>) -> Duration {
    times.sort();
    times[times.len() / 2]
}

fn main() {
    let base = desktop();
    // 5% of the screen: a 480×216 area of new text (103,680 of 2,073,600 pixels).
    let changed_area = Rect::new(200, 300, 480, 216);
    let mut changed = base.clone();
    text(&mut changed, changed_area, &mut Noise(0x9E37_79B9));

    for quality in [60, 85] {
        let mut full = Vec::with_capacity(RUNS);
        let mut partial = Vec::with_capacity(RUNS);
        let (mut full_bytes, mut partial_bytes, mut full_tiles, mut partial_tiles) = (0, 0, 0, 0);
        for _ in 0..RUNS {
            let mut encoder = TileEncoder::new();
            let started = Instant::now();
            let key = encoder
                .encode(&base, &Damage::Unknown, true, quality)
                .unwrap();
            full.push(started.elapsed());

            let started = Instant::now();
            let delta = encoder
                .encode(&changed, &Damage::Rects(vec![changed_area]), false, quality)
                .unwrap();
            partial.push(started.elapsed());

            let size = |tiles: &[bmuster_desktop::frame::Tile]| -> usize {
                tiles
                    .iter()
                    .map(|t| match &t.data {
                        bmuster_desktop::frame::TileData::Jpeg(b) => b.len() + 13,
                        bmuster_desktop::frame::TileData::Solid(_) => 17,
                    })
                    .sum()
            };
            full_bytes = size(&key.tiles);
            partial_bytes = size(&delta.tiles);
            full_tiles = key.tiles.len();
            partial_tiles = delta.tiles.len();
        }
        println!(
            "quality {quality}: full frame {:>7.2} ms, {full_tiles} tiles, {} KB | 5% changed {:>6.2} ms, {partial_tiles} tiles, {} KB",
            median(full).as_secs_f64() * 1000.0,
            full_bytes / 1024,
            median(partial).as_secs_f64() * 1000.0,
            partial_bytes / 1024,
        );
    }
}
