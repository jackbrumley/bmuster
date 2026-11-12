import { describe, expect, it } from 'vitest';
import { contentBox, toDisplay, toPage, type Box, type Size } from './input.ts';
import {
	clampToVisible,
	clampZoom,
	creepSpeed,
	crept,
	EDGE_PAN_SPEED,
	edgePanned,
	edgeVelocity,
	pannable,
	pushed,
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
/** A picture that fills the box. */
const fill = { width: 800, height: 600 };

describe('the picture zoom', () => {
	it('FA12: keeps the scale between 1x and 5x and the enlarged picture over the whole box', () => {
		expect(clampZoom({ scale: 0.5, x: 30, y: -10 }, base, fill)).toEqual(NO_ZOOM);
		expect(clampZoom({ scale: 9, x: 0, y: 0 }, base, fill).scale).toBe(MAX_ZOOM);
		expect(clampZoom({ scale: 2, x: 50, y: -900 }, base, fill)).toEqual({
			scale: 2,
			x: 0,
			y: -300
		});
	});

	it('FA12: a pinch scales about its midpoint, which stays under the fingers', () => {
		const from = pinchOf({ x: 170, y: 160 }, { x: 270, y: 160 });
		const to = pinchOf({ x: 120, y: 160 }, { x: 320, y: 160 });
		const zoom = pinched(NO_ZOOM, from, to, base, fill);
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
		expect(pinched(start, from, right, base, fill)).toEqual({ scale: 2, x: -70, y: -80 });
		const far = pinchOf({ x: 900, y: 100 }, { x: 1000, y: 100 });
		expect(pinched(start, from, far, base, fill).x).toBe(0);
	});

	it('FA13: a point maps through the zoom to the display pixel under it', () => {
		const display = { width: 1600, height: 1200 };
		const zoom = { scale: 2, x: -400, y: -300 };
		// The centre of the box shows the centre of the enlarged picture's bottom-right quarter.
		expect(toDisplay({ x: 220, y: 160 }, zoomedBox(base, zoom), fill, display)).toEqual({
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

/** A portrait phone's stage showing a landscape screen: 360x202.5 of picture, 218.75px bars above and below. */
const phone = { left: 0, top: 0, width: 360, height: 640 };
const landscape = { width: 1600, height: 900 };
const hd = { width: 1920, height: 1080 };

/** Where the picture shows on the page under `zoom`. */
function shownPicture(box: Box, zoom: Zoom, picture: Size): Box {
	return contentBox(zoomedBox(box, zoom), picture);
}

describe('the hard limit', () => {
	it('FA18: an axis where the picture fits never pans: a portrait phone showing a landscape screen pans across, not up and down', () => {
		expect(pannable(1, phone, landscape)).toEqual({ x: false, y: false });
		expect(pannable(2, phone, landscape)).toEqual({ x: true, y: false });
		// 3x is 607.5px tall, still inside the 640px stage; 5x is 1012.5px.
		expect(pannable(3, phone, landscape)).toEqual({ x: true, y: false });
		expect(pannable(5, phone, landscape)).toEqual({ x: true, y: true });
		// A pan up or down is undone; across it stays, inside the picture.
		expect(clampZoom({ scale: 2, x: -100, y: 0 }, phone, landscape)).toEqual({
			scale: 2,
			x: -100,
			y: -320
		});
		expect(clampZoom({ scale: 2, x: -100, y: -900 }, phone, landscape).y).toBe(-320);
		expect(clampZoom({ scale: 2, x: 500, y: 0 }, phone, landscape).x).toBe(0);
		expect(clampZoom({ scale: 2, x: -9999, y: 0 }, phone, landscape).x).toBe(-360);
	});

	it('FA18: the picture is centred on the axis where it fits', () => {
		const zoom = clampZoom({ scale: 2, x: -100, y: 250 }, phone, landscape);
		const shown = shownPicture(phone, zoom, landscape);
		expect(shown.height).toBeCloseTo(405, 6);
		expect(shown.top).toBeCloseTo(117.5, 6);
		expect(phone.height - (shown.top + shown.height)).toBeCloseTo(117.5, 6);
	});

	it('FA18: zooming out until an axis fits centres it again', () => {
		// An 800x400 picture shows 400x200 in the box: 2x is 400px tall (pans), 1.4x 280px (fits).
		const wide = { width: 800, height: 400 };
		const start = clampZoom({ scale: 2, x: -200, y: -150 }, base, wide);
		expect(start.y).toBe(-150);
		const from = pinchOf({ x: 170, y: 60 }, { x: 270, y: 60 });
		const to = pinchOf({ x: 185, y: 60 }, { x: 255, y: 60 });
		const out = pinched(start, from, to, base, wide);
		expect(out.scale).toBeCloseTo(1.4, 6);
		const shown = shownPicture(base, out, wide);
		expect(shown.top - base.top).toBeCloseTo(
			base.top + base.height - (shown.top + shown.height),
			6
		);
	});

	it('FA18: clamped, no offset shows past the picture at 1.5x, 3x or 5x', () => {
		const cases = [
			{ box: base, picture: fill },
			{ box: phone, picture: landscape }
		];
		for (const { box, picture } of cases) {
			for (const scale of [1.5, 3, 5]) {
				for (const x of [-10000, -123, 0, 10000]) {
					for (const y of [-10000, -77, 0, 10000]) {
						const zoom = clampZoom({ scale, x, y }, box, picture);
						const shown = shownPicture(box, zoom, picture);
						const pans = pannable(scale, box, picture);
						const axis = (
							start: number,
							size: number,
							from: number,
							length: number,
							along: boolean
						) => {
							if (along) {
								expect(start).toBeLessThanOrEqual(from + 1e-6);
								expect(start + size).toBeGreaterThanOrEqual(from + length - 1e-6);
							} else {
								expect(start - from).toBeCloseTo(from + length - (start + size), 6);
							}
						};
						axis(shown.left, shown.width, box.left, box.width, pans.x);
						axis(shown.top, shown.height, box.top, box.height, pans.y);
					}
				}
			}
		}
	});
});

describe('the trackpad pointer', () => {
	// The box is 400x300 at (20,10) and the picture fills it. At 2x a display pixel p shows at
	// page x 20 + offset + p / 2, and the margin is 40px at the sides and 30px at the top and bottom.
	const display = { width: 1600, height: 1200 };
	const zoom = { scale: 2, x: -200, y: -150 };
	/** Where a display pixel shows on the page under `at`. */
	const onPage = (point: { x: number; y: number }, at: Zoom) =>
		toPage(point, zoomedBox(base, at), fill, display);

	it('FA18: the trackpad pointer is kept to the display pixels shown on the page', () => {
		// At 2x the view shows display x 400–1199 and y 300–899.
		expect(clampToVisible({ x: 0, y: 0 }, base, zoom, fill, display)).toEqual({
			x: 400,
			y: 300
		});
		expect(clampToVisible({ x: 1600, y: 1200 }, base, zoom, fill, display)).toEqual({
			x: 1199,
			y: 899
		});
		expect(clampToVisible({ x: 1000.4, y: 700.6 }, base, zoom, fill, display)).toEqual({
			x: 1000,
			y: 701
		});
		// At 5x, x 640–959 and y 480–719; at 1x the whole display.
		const five = { scale: 5, x: -800, y: -600 };
		expect(clampToVisible({ x: 0, y: 2000 }, base, five, fill, display)).toEqual({
			x: 640,
			y: 719
		});
		expect(clampToVisible({ x: -5, y: 2000 }, base, NO_ZOOM, fill, display)).toEqual({
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

	it('FA18: a push past the margin line pans by the overflow, keeping the pointer on the line', () => {
		// Display x 1100 shows at page 370; moving 20px takes it 10px past the line at 380.
		expect(onPage({ x: 1100, y: 600 }, zoom)).toEqual({ x: 370, y: 160 });
		const view = pushed(zoom, base, fill, display, { x: 1100, y: 600 }, { x: 20, y: 0 });
		expect(view).toEqual({ zoom: { scale: 2, x: -210, y: -150 }, pointer: { x: 1140, y: 600 } });
		expect(onPage(view.pointer, view.zoom)).toEqual({ x: 380, y: 160 });
	});

	it('FA18: the push is the same at 1.5x, 3x and 5x: the pointer moves the whole way and stays on the line', () => {
		const cases = [
			{ at: { scale: 1.5, x: -100, y: -75 }, pointer: { x: 1200, y: 600 } },
			{ at: { scale: 3, x: -400, y: -300 }, pointer: { x: 1000, y: 600 } },
			{ at: { scale: 5, x: -800, y: -600 }, pointer: { x: 920, y: 600 } }
		];
		for (const { at, pointer } of cases) {
			expect(onPage(pointer, at)).toEqual({ x: 370, y: 160 });
			const view = pushed(at, base, fill, display, pointer, { x: 20, y: 0 });
			// 20 page pixels of finger is 80 / scale display pixels on the machine.
			expect(view.pointer).toEqual({ x: pointer.x + Math.round(80 / at.scale), y: 600 });
			expect(onPage(view.pointer, view.zoom).x).toBeCloseTo(380, 6);
			expect(view.zoom.y).toBe(at.y);
		}
	});

	it('FA18: pulling back moves the pointer away at once, with no pan', () => {
		const onLine = { scale: 2, x: -210, y: -150 };
		const back = pushed(onLine, base, fill, display, { x: 1140, y: 600 }, { x: -5, y: 0 });
		expect(back).toEqual({ zoom: onLine, pointer: { x: 1130, y: 600 } });
		// Deeper in the margin (after a creep): outward pans from where it is, inward moves it.
		const deep = { x: 1170, y: 600 };
		expect(onPage(deep, onLine).x).toBe(395);
		const out = pushed(onLine, base, fill, display, deep, { x: 2, y: 0 });
		expect(out.zoom.x).toBe(-212);
		expect(onPage(out.pointer, out.zoom).x).toBe(395);
		expect(pushed(onLine, base, fill, display, deep, { x: -2, y: 0 })).toEqual({
			zoom: onLine,
			pointer: { x: 1166, y: 600 }
		});
	});

	it('FA18: the push stops at the picture edge and the pointer never leaves the visible picture', () => {
		const near = { scale: 2, x: -395, y: -150 };
		const first = pushed(near, base, fill, display, { x: 1510, y: 600 }, { x: 40, y: 0 });
		expect(first).toEqual({ zoom: { scale: 2, x: -400, y: -150 }, pointer: { x: 1590, y: 600 } });
		const second = pushed(first.zoom, base, fill, display, first.pointer, { x: 40, y: 0 });
		expect(second).toEqual({ zoom: first.zoom, pointer: { x: 1599, y: 600 } });
		expect(onPage(second.pointer, second.zoom).x).toBeLessThan(base.left + base.width);
	});

	it('FA18: a push along an axis where the picture fits never pans', () => {
		const at = clampZoom({ scale: 2, x: -180, y: 0 }, phone, landscape);
		const view = pushed(at, phone, landscape, hd, { x: 960, y: 1000 }, { x: 0, y: 100 });
		expect(view.zoom).toEqual(at);
		expect(view.pointer).toEqual({ x: 960, y: 1079 });
	});

	it('FA18: the creep waits 300 ms, starts at 120 page pixels a second and ramps to 600 over 1.5 s', () => {
		expect(creepSpeed(0)).toBe(0);
		expect(creepSpeed(299)).toBe(0);
		expect(creepSpeed(300)).toBe(120);
		expect(creepSpeed(1050)).toBe(360);
		expect(creepSpeed(1800)).toBe(600);
		expect(creepSpeed(9000)).toBe(600);
	});

	it('FA18: a still pointer on the margin line creeps the view, the pointer keeping its place on the screen', () => {
		const onLine = { scale: 2, x: -210, y: -150 };
		const still = { x: 0, y: 0 };
		// 100 ms after 400 ms still: 152 page pixels a second, 15.2 page pixels, 30.4 display pixels.
		const step = crept(onLine, base, fill, display, { x: 1140, y: 600 }, 400, 100, still);
		expect(step.pointer).toEqual({ x: 1170, y: 600 });
		expect(step.zoom).toEqual({ scale: 2, x: -225, y: -150 });
		expect(step.carry.x).toBeCloseTo(0.4, 6);
		expect(step.carry.y).toBe(0);
		expect(onPage(step.pointer, step.zoom)).toEqual({ x: 380, y: 160 });
	});

	it('FA18: no creep before 300 ms still, inside the margin line, or on an axis where the picture fits', () => {
		const onLine = { scale: 2, x: -210, y: -150 };
		const still = { x: 0, y: 0 };
		expect(crept(onLine, base, fill, display, { x: 1140, y: 600 }, 299, 100, still)).toEqual({
			zoom: onLine,
			pointer: { x: 1140, y: 600 },
			carry: still
		});
		expect(crept(onLine, base, fill, display, { x: 1100, y: 600 }, 2000, 100, still)).toEqual({
			zoom: onLine,
			pointer: { x: 1100, y: 600 },
			carry: still
		});
		const at = clampZoom({ scale: 2, x: -180, y: 0 }, phone, landscape);
		expect(crept(at, phone, landscape, hd, { x: 960, y: 1079 }, 2000, 100, still)).toEqual({
			zoom: at,
			pointer: { x: 960, y: 1079 },
			carry: still
		});
	});

	it('FA18: the creep stops at the picture edge, the pointer on the visible picture', () => {
		let step = {
			zoom: { scale: 2, x: -210, y: -150 },
			pointer: { x: 1140, y: 600 },
			carry: { x: 0, y: 0 }
		};
		for (let frame = 0; frame < 300; frame += 1) {
			step = crept(step.zoom, base, fill, display, step.pointer, 300 + frame * 16, 16, step.carry);
			if (step.zoom.x > -400) {
				expect(onPage(step.pointer, step.zoom).x).toBeCloseTo(380, 6);
			}
		}
		expect(step.zoom).toEqual({ scale: 2, x: -400, y: -150 });
		expect(step.pointer.x).toBeLessThanOrEqual(1599);
		expect(onPage(step.pointer, step.zoom).x).toBeLessThan(base.left + base.width);
		const after = crept(step.zoom, base, fill, display, step.pointer, 9000, 16, step.carry);
		expect(after.zoom).toEqual(step.zoom);
		expect(after.pointer).toEqual(step.pointer);
	});
});

describe('tap to click edge pan', () => {
	const zoom = { scale: 2, x: -200, y: -150 };
	const area = { left: 20, top: 10, width: 400, height: 300 };

	it('FA18: the finger band has a dead zone in the middle and speeds up with the depth into the band', () => {
		expect(edgeVelocity(area, { x: 220, y: 160 })).toEqual({ x: 0, y: 0 });
		// On the band's inner edge: still nothing.
		expect(edgeVelocity(area, { x: 120, y: 85 })).toEqual({ x: 0, y: 0 });
		// Half way into the left band: half speed, the picture moving right.
		expect(edgeVelocity(area, { x: 70, y: 160 })).toEqual({ x: EDGE_PAN_SPEED / 2, y: 0 });
		// At the right edge, and past the bottom: full speed both ways.
		expect(edgeVelocity(area, { x: 420, y: 400 })).toEqual({
			x: -EDGE_PAN_SPEED,
			y: -EDGE_PAN_SPEED
		});
	});

	it('FA18: under a finger (tap to click) pans towards the edge, inside the hard limit', () => {
		const step = EDGE_PAN_SPEED / 10;
		expect(edgePanned(NO_ZOOM, base, fill, { x: 21, y: 11 }, 100)).toEqual(NO_ZOOM);
		expect(edgePanned(zoom, base, fill, { x: 220, y: 160 }, 100)).toEqual(zoom);
		expect(edgePanned(zoom, base, fill, { x: 70, y: 160 }, 100)).toEqual({
			...zoom,
			x: -200 + step / 2
		});
		expect(edgePanned({ scale: 2, x: -5, y: 0 }, base, fill, { x: 20, y: 10 }, 1000)).toEqual({
			scale: 2,
			x: 0,
			y: 0
		});
		// On a portrait phone at 2x the finger at the bottom never pans up or down.
		const at = clampZoom({ scale: 2, x: -180, y: 0 }, phone, landscape);
		expect(edgePanned(at, phone, landscape, { x: 180, y: 520 }, 1000)).toEqual(at);
	});
});
