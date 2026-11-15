import { describe, expect, it } from 'vitest';
import {
	barAtGrip,
	barCorner,
	barPlaceAt,
	buttonAtGrip,
	buttonCentre,
	clampCorner,
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

	it('FB5: collapsing puts the button where the grip was, snapped to the nearest edge', () => {
		// The grip near the top, in the middle: the button goes to the top edge, centred under it.
		const top = buttonAtGrip({ x: 500, y: 30 }, area, 48);
		expect(top).toEqual({ edge: 'top', at: (500 - 24) / 952 });
		expect(buttonCentre(top, area, 48).x).toBeCloseTo(500);
		// The grip near the left edge, low down: the button goes to the left edge, level with it.
		const left = buttonAtGrip({ x: 40, y: 400 }, area, 48);
		expect(left).toEqual({ edge: 'left', at: (400 - 24) / 552 });
		expect(buttonCentre(left, area, 48).y).toBeCloseTo(400);
		// A grip in the corner keeps the button inside the screen.
		expect(buttonAtGrip({ x: -10, y: -10 }, area, 48)).toEqual({ edge: 'left', at: 0 });
	});

	it('FB5: expanding puts the grip on the button, fitted inside the screen', () => {
		const grip = { x: 25, y: 24 };
		// The button on the top edge: the bar opens with its grip's centre on the button's.
		const button = { edge: 'top', at: 0.5 } as const;
		const centre = buttonCentre(button, area, 48);
		const corner = barCorner(barAtGrip(centre, grip, area, bar), area, bar);
		expect(corner.x + grip.x).toBeCloseTo(centre.x);
		expect(corner.y + grip.y).toBeCloseTo(centre.y);
		// The button on the right edge: the bar cannot start there, so it ends at the screen's edge.
		const right = buttonCentre({ edge: 'right', at: 0.5 }, area, 48);
		const fitted = barCorner(barAtGrip(right, grip, area, bar), area, bar);
		expect(fitted.x).toBe(area.width - bar.width);
		expect(fitted.y + grip.y).toBeCloseTo(right.y);
	});

	it('FB5: collapsing and expanding again lands the grip back where it was', () => {
		const grip = { x: 25, y: 24 };
		for (const place of [
			{ x: 0.5, y: 0 },
			{ x: 0, y: 1 },
			{ x: 0, y: 0.3 },
			{ x: 0.2, y: 0 }
		]) {
			const at = barCorner(place, area, bar);
			const button = buttonAtGrip({ x: at.x + grip.x, y: at.y + grip.y }, area, 48);
			const again = barAtGrip(buttonCentre(button, area, 48), grip, area, bar);
			expect(again.x).toBeCloseTo(place.x);
			expect(again.y).toBeCloseTo(place.y);
		}
	});
});
