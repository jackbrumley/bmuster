use super::*;

fn display(id: &str, x: i32, y: i32, width: u32, height: u32) -> DisplayInfo {
    DisplayInfo {
        id: id.into(),
        name: id.into(),
        x,
        y,
        width,
        height,
        scale: 1.0,
        primary: x == 0 && y == 0,
    }
}

fn solid(width: u32, height: u32, bgrx: [u8; 4]) -> Frame {
    let mut frame = Frame::new(width, height);
    frame.fill(Rect::new(0, 0, width, height), bgrx);
    frame
}

fn pixel(frame: &Frame, x: u32, y: u32) -> [u8; 4] {
    let at = x as usize * 4;
    frame.row(y)[at..at + 4].try_into().unwrap()
}

const RED: [u8; 4] = [0, 0, 255, 0];
const BLUE: [u8; 4] = [255, 0, 0, 0];
const BLACK: [u8; 4] = [0, 0, 0, 0];

#[test]
fn combined_two_sizes_side_by_side_with_the_gap_black() {
    // A 40x30 panel and a 20x10 monitor to its right, top-aligned.
    let displays = [display("a", 0, 0, 40, 30), display("b", 40, 0, 20, 10)];
    let mut combined = Combined::new(&displays).unwrap();
    assert_eq!(combined.bounds(), Rect::new(0, 0, 60, 30));
    let mut frame = combined.blank();
    combined.draw(&mut frame, 0, &solid(40, 30, RED));
    combined.draw(&mut frame, 1, &solid(20, 10, BLUE));
    // The edge pixels on either side of the seam.
    assert_eq!(pixel(&frame, 39, 0), RED);
    assert_eq!(pixel(&frame, 40, 0), BLUE);
    assert_eq!(pixel(&frame, 59, 9), BLUE);
    // Under the smaller monitor nothing is: black.
    assert_eq!(pixel(&frame, 40, 10), BLACK);
    assert_eq!(pixel(&frame, 59, 29), BLACK);
}

#[test]
fn combined_one_above_the_other_with_negative_offsets() {
    // Mutter and Windows both allow a monitor above and left of the
    // primary: the frame starts at the top-left corner of the box.
    let displays = [
        display("main", 0, 0, 30, 20),
        display("top", -10, -15, 20, 15),
    ];
    let mut combined = Combined::new(&displays).unwrap();
    assert_eq!(combined.bounds(), Rect::new(-10, -15, 40, 35));
    assert_eq!(combined.place(0), Some(Rect::new(10, 15, 30, 20)));
    assert_eq!(combined.place(1), Some(Rect::new(0, 0, 20, 15)));
    let mut frame = combined.blank();
    combined.draw(&mut frame, 0, &solid(30, 20, RED));
    combined.draw(&mut frame, 1, &solid(20, 15, BLUE));
    assert_eq!(pixel(&frame, 0, 0), BLUE);
    assert_eq!(pixel(&frame, 19, 14), BLUE);
    assert_eq!(pixel(&frame, 10, 15), RED);
    assert_eq!(pixel(&frame, 39, 34), RED);
    // Right of the top monitor and left of the main one: gaps.
    assert_eq!(pixel(&frame, 25, 5), BLACK);
    assert_eq!(pixel(&frame, 5, 20), BLACK);
}

#[test]
fn combined_resamples_an_image_larger_than_its_place() {
    // A scale-2 panel laid out in logical pixels: 40x20 of image in a
    // 20x10 place.
    let displays = [display("hidpi", 0, 0, 20, 10), display("b", 20, 0, 10, 10)];
    let mut combined = Combined::new(&displays).unwrap();
    let mut image = solid(40, 20, RED);
    image.fill(Rect::new(20, 0, 20, 20), BLUE);
    let mut frame = combined.blank();
    combined.draw(&mut frame, 0, &image);
    assert_eq!((frame.width, frame.height), (30, 10));
    assert_eq!(pixel(&frame, 9, 5), RED);
    assert_eq!(pixel(&frame, 10, 5), BLUE);
    assert_eq!(pixel(&frame, 20, 5), BLACK);
    // Its damage is scaled into the place too.
    assert_eq!(
        combined.damage(0, (40, 20), &Damage::Rects(vec![Rect::new(20, 10, 4, 4)])),
        Damage::Rects(vec![Rect::new(10, 5, 3, 3)])
    );
}

#[test]
fn combined_damage_moves_to_the_place() {
    let displays = [display("a", 0, 0, 40, 30), display("b", 40, 0, 20, 10)];
    let combined = Combined::new(&displays).unwrap();
    assert_eq!(
        combined.damage(1, (20, 10), &Damage::Rects(vec![Rect::new(1, 2, 3, 4)])),
        Damage::Rects(vec![Rect::new(41, 2, 3, 4)])
    );
    assert_eq!(
        combined.damage(1, (20, 10), &Damage::Unknown),
        Damage::Rects(vec![Rect::new(40, 0, 20, 10)])
    );
    assert_eq!(combined.damage(1, (20, 10), &Damage::None), Damage::None);
}

#[test]
fn combined_blank_gaps_clears_only_what_no_display_covers() {
    let displays = [display("a", 0, 0, 4, 4), display("b", 4, 0, 2, 2)];
    let combined = Combined::new(&displays).unwrap();
    // A whole-desktop grab that shows something under monitor b.
    let mut frame = solid(6, 4, RED);
    combined.blank_gaps(&mut frame, Rect::new(0, 0, 6, 4));
    assert_eq!(pixel(&frame, 3, 3), RED);
    assert_eq!(pixel(&frame, 5, 1), RED);
    assert_eq!(pixel(&frame, 4, 2), BLACK);
    assert_eq!(pixel(&frame, 5, 3), BLACK);
    // Only inside the area asked for.
    let mut frame = solid(6, 4, RED);
    combined.blank_gaps(&mut frame, Rect::new(5, 3, 1, 1));
    assert_eq!(pixel(&frame, 4, 2), RED);
    assert_eq!(pixel(&frame, 5, 3), BLACK);
}

#[test]
fn combined_needs_two_displays_and_a_sane_size() {
    assert!(Combined::new(&[display("a", 0, 0, 10, 10)]).is_none());
    assert!(!Combined::possible(&[]));
    assert!(Combined::possible(&[
        display("a", 0, 0, 10, 10),
        display("b", 10, 0, 10, 10)
    ]));
    // A layout that would make a frame wider than MAX_SIDE.
    assert!(!Combined::possible(&[
        display("a", 0, 0, 10, 10),
        display("b", MAX_SIDE as i32, 0, 10, 10)
    ]));
    // Or more than MAX_PIXELS.
    assert!(!Combined::possible(&[
        display("a", 0, 0, 8200, 8200),
        display("b", 8200, 0, 8000, 8200)
    ]));
}
