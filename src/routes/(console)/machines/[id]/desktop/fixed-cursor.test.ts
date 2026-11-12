import { describe, expect, it } from 'vitest';
import { centredOn, centreOf, clampFixed, dragged, underCentre } from './fixed-cursor.ts';

// SPEC-DESKTOP-FLOATING FA22, FA23, FA24.

/** A 400x300 box at (20,10) showing an 800x600 picture of a 1600x1200 display. */
const base = { left: 20, top: 10, width: 400, height: 300 };
const picture = { width: 800, height: 600 };
const display = { width: 1600, height: 1200 };

describe('the fixed cursor', () => {
	it('FA22: the pointer is the display pixel under the centre of the box', () => {
		expect(centreOf(base)).toEqual({ x: 220, y: 160 });
		expect(underCentre({ scale: 1, x: 0, y: 0 }, base, picture, display)).toEqual({
			x: 800,
			y: 600
		});
		// Moving the picture 20px right puts the pixel 80 to the left under the centre.
		expect(underCentre({ scale: 1, x: 20, y: 0 }, base, picture, display)).toEqual({
			x: 720,
			y: 600
		});
		expect(underCentre({ scale: 2, x: -400, y: -300 }, base, picture, display)).toEqual({
			x: 1200,
			y: 900
		});
	});

	it('FA23: centring on a pixel at any zoom keeps it under the centre', () => {
		for (const scale of [1, 2, 3.5, 5]) {
			const zoom = centredOn(scale, { x: 321, y: 987 }, base, picture, display);
			expect(zoom.scale).toBe(scale);
			expect(underCentre(zoom, base, picture, display)).toEqual({ x: 321, y: 987 });
		}
		expect(centredOn(9, { x: 0, y: 0 }, base, picture, display).scale).toBe(5);
	});

	it('FA24: the picture moves at most until its edge reaches the centre: half the box each way at 1x', () => {
		expect(clampFixed({ scale: 1, x: 900, y: -900 }, base, picture)).toEqual({
			scale: 1,
			x: 200,
			y: -150
		});
		expect(clampFixed({ scale: 3, x: -9000, y: 9000 }, base, picture)).toEqual({
			scale: 3,
			x: 200 - 1200,
			y: 150
		});
		expect(dragged({ scale: 1, x: 0, y: 0 }, 50, -30, base, picture)).toEqual({
			scale: 1,
			x: 50,
			y: -30
		});
	});

	it('FA24: every corner of the display can sit under the centre, at 1x and at 3x', () => {
		for (const scale of [1, 3]) {
			const far = 99999;
			const corners = [
				[far, far, 0, 0],
				[-far, far, 1599, 0],
				[far, -far, 0, 1199],
				[-far, -far, 1599, 1199]
			] as const;
			for (const [dx, dy, x, y] of corners) {
				const zoom = dragged({ scale, x: 0, y: 0 }, dx, dy, base, picture);
				expect(underCentre(zoom, base, picture, display)).toEqual({ x, y });
			}
		}
	});

	it('FA24: with bars beside the picture, its edge (not the bar) is the limit', () => {
		// A 16:9 picture in a 400x300 box: 225px tall, 37.5px bars above and below.
		const wide = { width: 1600, height: 900 };
		const zoom = clampFixed({ scale: 1, x: 0, y: 9999 }, base, wide);
		expect(zoom.y).toBe(150 - 37.5);
		expect(underCentre(zoom, base, wide, { width: 1920, height: 1080 })).toEqual({
			x: 960,
			y: 0
		});
	});
});
