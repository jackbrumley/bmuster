import { describe, expect, it } from 'vitest';
import { toDisplay } from './input.ts';
import {
	clampZoom,
	MAX_ZOOM,
	NO_ZOOM,
	pinched,
	pinchOf,
	zoomedBox,
	zoomTransform
} from './zoom.ts';

// SPEC-DESKTOP-FLOATING FA12, FA13.

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
});
