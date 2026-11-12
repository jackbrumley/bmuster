import { describe, expect, it } from 'vitest';
import { toDisplay, toPage } from './input.ts';
import {
	clampToVisible,
	clampZoom,
	EDGE_PAN_SPEED,
	edgePanned,
	edgeVelocity,
	joystickPanned,
	visibleArea,
	MAX_ZOOM,
	NO_ZOOM,
	pinched,
	pinchOf,
	zoomedBox,
	zoomTransform,
	type Zoom
} from './zoom.ts';

// SPEC-DESKTOP-FLOATING FA12, FA13, FA18, FA24.

const base = { left: 20, top: 10, width: 400, height: 300 };

describe('the picture zoom', () => {
	it('FA12: keeps the scale between 1x and 5x and the enlarged picture over the whole box', () => {
		expect(clampZoom({ scale: 0.5, x: 30, y: -10 }, base)).toEqual(NO_ZOOM);
		expect(clampZoom({ scale: 9, x: 0, y: 0 }, base).scale).toBe(MAX_ZOOM);
		expect(clampZoom({ scale: 2, x: 50, y: -900 }, base)).toEqual({ scale: 2, x: 0, y: -300 });
	});

	it('FA12: a pinch scales about its midpoint, which stays under the fingers', () => {
		const from = pinchOf({ x: 170, y: 160 }, { x: 270, y: 160 });
		const to = pinchOf({ x: 120, y: 160 }, { x: 320, y: 160 });
		const zoom = pinched(NO_ZOOM, from, to, base);
		expect(zoom.scale).toBe(2);
		// The point under the midpoint (220,160) before is under it after.
		const box = zoomedBox(base, zoom);
		const before = { x: (220 - base.left) / base.width, y: (160 - base.top) / base.height };
		expect((220 - box.left) / box.width).toBeCloseTo(before.x, 6);
		expect((160 - box.top) / box.height).toBeCloseTo(before.y, 6);
	});

	it('FA12: two fingers moving together pan a zoomed picture, never past its edges', () => {
		const start = { scale: 2, x: -100, y: -100 };
		const from = pinchOf({ x: 100, y: 100 }, { x: 200, y: 100 });
		const right = pinchOf({ x: 130, y: 120 }, { x: 230, y: 120 });
		expect(pinched(start, from, right, base)).toEqual({ scale: 2, x: -70, y: -80 });
		const far = pinchOf({ x: 900, y: 100 }, { x: 1000, y: 100 });
		expect(pinched(start, from, far, base).x).toBe(0);
	});

	it('FA13: a point maps through the zoom to the display pixel under it', () => {
		const picture = { width: 800, height: 600 };
		const display = { width: 1600, height: 1200 };
		const zoom = { scale: 2, x: -400, y: -300 };
		// The centre of the box shows the centre of the enlarged picture's bottom-right quarter.
		expect(toDisplay({ x: 220, y: 160 }, zoomedBox(base, zoom), picture, display)).toEqual({
			x: 1200,
			y: 900
		});
		expect(zoomTransform(zoom)).toBe('translate(-400px, -300px) scale(2)');
		expect(zoomTransform(NO_ZOOM)).toBeUndefined();
	});

	it('FA24: a picture moved off its corner at 1x is still drawn with its offset', () => {
		expect(zoomTransform({ scale: 1, x: 20, y: -5 })).toBe('translate(20px, -5px) scale(1)');
	});
});

describe('edge pan', () => {
	// The box is 400x300 at (20,10) and the picture fills it: the band is 100px at the sides
	// and 75px at the top and bottom, whatever the zoom.
	const picture = { width: 800, height: 600 };
	const display = { width: 1600, height: 1200 };
	const zoom = { scale: 2, x: -200, y: -150 };
	const area = { left: 20, top: 10, width: 400, height: 300 };
	/** Where a display pixel shows on the page under `at`. */
	const onPage = (point: { x: number; y: number }, at: Zoom) =>
		toPage(point, zoomedBox(base, at), picture, display);

	it('FA18: the trackpad pointer is kept to the display pixels shown on the page', () => {
		// At 2x the view shows display x 400–1199 and y 300–899.
		expect(clampToVisible({ x: 0, y: 0 }, base, zoom, picture, display)).toEqual({
			x: 400,
			y: 300
		});
		expect(clampToVisible({ x: 1600, y: 1200 }, base, zoom, picture, display)).toEqual({
			x: 1199,
			y: 899
		});
		expect(clampToVisible({ x: 1000.4, y: 700.6 }, base, zoom, picture, display)).toEqual({
			x: 1000,
			y: 701
		});
		// At 5x, x 640–959 and y 480–719; at 1x the whole display.
		const five = { scale: 5, x: -800, y: -600 };
		expect(clampToVisible({ x: 0, y: 2000 }, base, five, picture, display)).toEqual({
			x: 640,
			y: 719
		});
		expect(clampToVisible({ x: -5, y: 2000 }, base, NO_ZOOM, picture, display)).toEqual({
			x: 0,
			y: 1199
		});
	});

	it('FA18: letterbox bars are not part of the visible picture', () => {
		// An 800x400 picture shows 400x200 in the box, with 50px bars above and below.
		const wide = { width: 800, height: 400 };
		const flat = { width: 1600, height: 800 };
		const at = { scale: 1.5, x: 0, y: 0 };
		expect(visibleArea(base, at, wide)).toEqual({ left: 20, top: 85, width: 400, height: 225 });
		expect(clampToVisible({ x: 1500, y: 790 }, base, at, wide, flat)).toEqual({ x: 1066, y: 599 });
	});

	it('FA18: the joystick has a dead zone in the middle and speeds up with the depth into the band', () => {
		expect(edgeVelocity(area, { x: 220, y: 160 })).toEqual({ x: 0, y: 0 });
		// On the band's inner edge: still nothing.
		expect(edgeVelocity(area, { x: 120, y: 85 })).toEqual({ x: 0, y: 0 });
		// Half way into the left band: half speed, the picture moving right.
		expect(edgeVelocity(area, { x: 70, y: 160 })).toEqual({ x: EDGE_PAN_SPEED / 2, y: 0 });
		// A quarter into the bottom band: a quarter speed, the picture moving up.
		expect(edgeVelocity(area, { x: 220, y: 310 - 75 + 75 / 4 })).toEqual({
			x: 0,
			y: -EDGE_PAN_SPEED / 4
		});
		// At the right edge, and past the bottom: full speed both ways.
		expect(edgeVelocity(area, { x: 420, y: 400 })).toEqual({
			x: -EDGE_PAN_SPEED,
			y: -EDGE_PAN_SPEED
		});
	});

	it('FA18: under a finger (tap to click) pans towards the edge, never past the picture, and not at 1x', () => {
		const step = EDGE_PAN_SPEED / 10;
		expect(edgePanned(NO_ZOOM, base, picture, { x: 21, y: 11 }, 100)).toEqual(NO_ZOOM);
		expect(edgePanned(zoom, base, picture, { x: 220, y: 160 }, 100)).toEqual(zoom);
		expect(edgePanned(zoom, base, picture, { x: 70, y: 160 }, 100)).toEqual({
			...zoom,
			x: -200 + step / 2
		});
		expect(edgePanned({ scale: 2, x: -5, y: 0 }, base, picture, { x: 20, y: 10 }, 1000)).toEqual({
			scale: 2,
			x: 0,
			y: 0
		});
	});

	it('FA18: the trackpad pointer keeps its place on the page and travels with the view, at 1.5x, 2x and 5x', () => {
		// Half way into the right band (page x 370), mid height: 45 page pixels in 100 ms at every zoom.
		const cases = [
			{ at: { scale: 1.5, x: -100, y: -75 }, pointer: { x: 1200, y: 600 }, moved: 120 },
			{ at: zoom, pointer: { x: 1100, y: 600 }, moved: 90 },
			{ at: { scale: 5, x: -800, y: -600 }, pointer: { x: 920, y: 600 }, moved: 36 }
		];
		for (const { at, pointer, moved } of cases) {
			expect(onPage(pointer, at)).toEqual({ x: 370, y: 160 });
			const next = joystickPanned(at, base, picture, display, pointer, 100, { x: 0, y: 0 });
			expect(next.zoom).toEqual({ ...at, x: at.x - 45 });
			// The remote pointer moves right with the view, by the display pixels the view moved.
			expect(next.pointer).toEqual({ x: pointer.x + moved, y: pointer.y });
			expect(onPage(next.pointer, next.zoom)).toEqual({ x: 370, y: 160 });
			expect(next.carry).toEqual({ x: 0, y: 0 });
		}
	});

	it('FA18: the trackpad joystick does nothing in the dead zone or at 1x', () => {
		const still = { x: 0, y: 0 };
		expect(joystickPanned(zoom, base, picture, display, { x: 800, y: 600 }, 100, still)).toEqual({
			zoom,
			pointer: { x: 800, y: 600 },
			carry: still
		});
		expect(
			joystickPanned(NO_ZOOM, base, picture, display, { x: 1599, y: 600 }, 100, still)
		).toEqual({ zoom: NO_ZOOM, pointer: { x: 1599, y: 600 }, carry: still });
	});

	it('FA18: the trackpad joystick stops at the picture edge, the pointer stopping with it', () => {
		const near = { scale: 2, x: -395, y: -150 };
		// Page x 370: 90 display pixels wanted, 10 left before the picture's right edge shows.
		const pointer = { x: 1490, y: 600 };
		const next = joystickPanned(near, base, picture, display, pointer, 100, { x: 0, y: 0 });
		expect(next).toEqual({
			zoom: { scale: 2, x: -400, y: -150 },
			pointer: { x: 1500, y: 600 },
			carry: { x: 0, y: 0 }
		});
		expect(
			joystickPanned(next.zoom, base, picture, display, next.pointer, 100, next.carry)
		).toEqual(next);
	});

	it('FA18: a slow pan carries part-pixels until a whole display pixel is due', () => {
		// Page x 321: 1% into the band, 9 page pixels a second, 0.288 display pixels a 16 ms frame.
		let step = { zoom, pointer: { x: 1002, y: 600 }, carry: { x: 0, y: 0 } };
		const pointers: number[] = [];
		for (let frame = 0; frame < 4; frame += 1) {
			step = joystickPanned(step.zoom, base, picture, display, step.pointer, 16, step.carry);
			pointers.push(step.pointer.x);
		}
		expect(pointers).toEqual([1002, 1002, 1002, 1003]);
		expect(step.zoom.x).toBe(-200.5);
		expect(step.carry.x).toBeCloseTo(0.152, 6);
	});
});
