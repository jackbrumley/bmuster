import { describe, expect, it } from 'vitest';
import {
	barBeside,
	barCorner,
	barPlaceAt,
	buttonBeside,
	clampCorner,
	cornerOf,
	nudged,
	snapped
} from './floating-position.ts';

// SPEC-DESKTOP-FLOATING F2, FA1, FB3, FB4, FB5.

describe('the floating button position', () => {
	it('FA1: snaps to the nearest of the four edges and keeps its place along it', () => {
		// The button can travel 303 across and 595 down.
		const area = { width: 351, height: 643 };
		expect(snapped({ x: 10, y: 297.5 }, area, 48)).toEqual({ edge: 'left', at: 0.5 });
		expect(snapped({ x: 280, y: 595 * 0.25 }, area, 48)).toEqual({ edge: 'right', at: 0.25 });
		expect(snapped({ x: 151.5, y: 4 }, area, 48)).toEqual({ edge: 'top', at: 0.5 });
		expect(snapped({ x: 75.75, y: 594 }, area, 48)).toEqual({ edge: 'bottom', at: 0.25 });
		// A corner tie goes to the side edge.
		expect(snapped({ x: 0, y: 0 }, area, 48)).toEqual({ edge: 'left', at: 0 });
		// No room to travel along the edge: halfway.
		expect(snapped({ x: 0, y: 0 }, { width: 40, height: 40 }, 48).at).toBe(0.5);
	});

	it('F2: keeps a dragged button inside the area', () => {
		const area = { width: 300, height: 500 };
		expect(clampCorner({ x: -20, y: 900 }, area, 48)).toEqual({ x: 0, y: 452 });
		expect(clampCorner({ x: 400, y: -5 }, area, 48)).toEqual({ x: 252, y: 0 });
	});
});

describe('the floating bar position', () => {
	const area = { width: 1000, height: 600 };
	const bar = { width: 400, height: 48 };

	it('FB3: keeps its place as a fraction of its room, and stays inside the screen', () => {
		expect(barPlaceAt({ x: 300, y: 276 }, area, bar)).toEqual({ x: 0.5, y: 0.5 });
		expect(barPlaceAt({ x: -50, y: 900 }, area, bar)).toEqual({ x: 0, y: 1 });
		expect(barCorner({ x: 0.5, y: 1 }, area, bar)).toEqual({ x: 300, y: 552 });
		// A narrower window keeps the bar inside it.
		expect(barCorner({ x: 1, y: 0 }, { width: 500, height: 600 }, bar)).toEqual({ x: 100, y: 0 });
		// A bar as wide as the screen has no room to move: it sits at the start.
		expect(barPlaceAt({ x: 10, y: 0 }, { width: 400, height: 600 }, bar).x).toBe(0);
	});

	it('FB4: the arrow keys move it, never past the edge', () => {
		expect(nudged({ x: 0.5, y: 0 }, { x: 16, y: 16 }, area, bar)).toEqual({
			x: 316 / 600,
			y: 16 / 552
		});
		expect(nudged({ x: 0, y: 0 }, { x: -64, y: -64 }, area, bar)).toEqual({ x: 0, y: 0 });
	});

	it('FB5: opens next to the button, running towards the middle of the screen', () => {
		// The button on the right edge, near the top: the bar ends at the button, level with it.
		const right = barCorner(barBeside({ edge: 'right', at: 0.1 }, area, bar, 48), area, bar);
		const button = cornerOf({ edge: 'right', at: 0.1 }, area, 48);
		expect(right.x + bar.width).toBeCloseTo(button.x + 48);
		expect(right.y).toBeCloseTo(button.y);
		// The button on the bottom edge, at the left: the bar starts at it and sits on the bottom.
		const left = barCorner(barBeside({ edge: 'bottom', at: 0 }, area, bar, 48), area, bar);
		expect(left).toEqual({ x: 0, y: 552 });
	});

	it('FB5: collapsing puts the button at the bar end nearer the edge, and expanding lands back', () => {
		for (const place of [
			{ x: 0.5, y: 0 },
			{ x: 0, y: 1 },
			{ x: 1, y: 0.3 },
			{ x: 0.2, y: 0 }
		]) {
			const button = buttonBeside(place, area, bar, 48);
			const again = barBeside(button, area, bar, 48);
			expect(again.x).toBeCloseTo(place.x);
			expect(again.y).toBeCloseTo(place.y);
		}
		expect(buttonBeside({ x: 0.5, y: 0 }, area, bar, 48)).toEqual({
			edge: 'top',
			at: (700 - 48) / 952
		});
	});
});
