import { describe, expect, it } from 'vitest';
import {
	cursorCrop,
	cssCursorSize,
	cssCursorValues,
	cursorScale,
	displayToFrame,
	frameToDisplay,
	MAX_CSS_CURSOR,
	planCursor,
	SETTLE_MS,
	type CursorState
} from './cursor-plan.ts';

// SPEC-DESKTOP 20: LC1–LC7.

/** A mouse controlling the machine, over the picture, just moved to (100, 50), where the agent agrees. */
const MOVING: CursorState = {
	controlling: true,
	kind: 'mouse',
	reportsCursor: true,
	reported: { x: 100, y: 50, visible: true },
	sent: { x: 100, y: 50 },
	over: true,
	sinceInput: 16,
	fits: true
};

describe('the local cursor plan', () => {
	it('LC1: a mouse controlling the machine wears the remote shape, and the canvas draws nothing while it moves', () => {
		expect(planCursor(MOVING)).toEqual({ css: 'image', canvas: { kind: 'none' } });
		// The agent's report lags behind the mouse: still no second cursor.
		expect(planCursor({ ...MOVING, reported: { x: 60, y: 20, visible: true } })).toEqual({
			css: 'image',
			canvas: { kind: 'none' }
		});
		// At rest where the agent agrees: still one cursor.
		expect(planCursor({ ...MOVING, sinceInput: SETTLE_MS + 1 }).canvas).toEqual({ kind: 'none' });
	});

	it('LC2: the reported cursor is drawn again when the remote pointer moves without our input', () => {
		const elsewhere = { x: 300, y: 200, visible: true };
		expect(planCursor({ ...MOVING, reported: elsewhere, sinceInput: SETTLE_MS }).canvas).toEqual({
			kind: 'at',
			x: 300,
			y: 200
		});
		// A few pixels of rounding is not a move.
		expect(
			planCursor({ ...MOVING, reported: { x: 103, y: 51, visible: true }, sinceInput: SETTLE_MS })
				.canvas
		).toEqual({ kind: 'none' });
		// Never sent: the reported cursor shows beside the viewer's.
		expect(planCursor({ ...MOVING, sent: undefined, sinceInput: Infinity }).canvas).toEqual({
			kind: 'at',
			x: 100,
			y: 50
		});
	});

	it('LC3: view only never changes the CSS cursor and always draws the reported cursor', () => {
		const watching = { ...MOVING, controlling: false };
		expect(planCursor(watching)).toEqual({ css: 'default', canvas: { kind: 'at', x: 100, y: 50 } });
		expect(planCursor({ ...watching, reported: { x: 1, y: 2, visible: false } })).toEqual({
			css: 'default',
			canvas: { kind: 'none' }
		});
	});

	it('LC4: touch draws at the predicted position at once, then snaps to the reported one once input rests', () => {
		const touch: CursorState = {
			...MOVING,
			kind: 'touch',
			over: false,
			sent: { x: 140, y: 70 },
			reported: { x: 100, y: 50, visible: true }
		};
		expect(planCursor(touch)).toEqual({ css: 'default', canvas: { kind: 'at', x: 140, y: 70 } });
		expect(planCursor({ ...touch, sinceInput: SETTLE_MS }).canvas).toEqual({
			kind: 'at',
			x: 100,
			y: 50
		});
	});

	it('LC5: a hidden remote cursor hides the local one too, but not over controls laid on the picture', () => {
		const hidden = { ...MOVING, reported: { x: 100, y: 50, visible: false } };
		expect(planCursor(hidden)).toEqual({ css: 'none', canvas: { kind: 'none' } });
		expect(planCursor({ ...hidden, over: false })).toEqual({
			css: 'default',
			canvas: { kind: 'none' }
		});
		expect(planCursor({ ...hidden, kind: 'touch' }).canvas).toEqual({ kind: 'none' });
	});

	it('LC6: an agent that sends no cursor shapes (cursor in the picture) leaves the viewer cursor alone', () => {
		const embedded = { ...MOVING, reportsCursor: false, reported: { x: 0, y: 0, visible: false } };
		expect(planCursor(embedded)).toEqual({ css: 'default', canvas: { kind: 'none' } });
	});

	it('LC7: a shape too big for a CSS cursor is drawn on the canvas where we sent the pointer', () => {
		const big = { ...MOVING, fits: false, reported: { x: 60, y: 20, visible: true } };
		expect(planCursor(big)).toEqual({ css: 'none', canvas: { kind: 'at', x: 100, y: 50 } });
		// Off the picture (over a control), the viewer's own cursor and the reported one.
		expect(planCursor({ ...big, over: false })).toEqual({
			css: 'default',
			canvas: { kind: 'at', x: 60, y: 20 }
		});
	});
});

describe('the CSS cursor', () => {
	it('LC7: is sized at the picture scale and zoom, and refused over the safe maximum', () => {
		// A 1920-pixel stream shown 960 CSS pixels wide, zoomed 2x: one to one.
		expect(cursorScale(960, 1920, 2)).toBe(1);
		expect(cursorScale(960, 1920, 1)).toBe(0.5);
		expect(cssCursorSize({ width: 32, height: 32 }, 0.5)).toEqual({ width: 16, height: 16 });
		expect(cssCursorSize({ width: 32, height: 32 }, 1)).toEqual({ width: 32, height: 32 });
		expect(cssCursorSize({ width: 48, height: 48 }, 1)).toBeUndefined();
		expect(cssCursorSize({ width: 32, height: 32 }, 2)).toBeUndefined();
		expect(cssCursorSize({ width: 1, height: 1 }, 0.2)).toBeUndefined();
		expect(MAX_CSS_CURSOR).toBe(32);
	});

	it('LC1: builds image-set for a sharp picture and url() for a plain one, falling back to auto', () => {
		const values = cssCursorValues(
			[
				{ url: 'data:image/png;base64,AA', pixelRatio: 2 },
				{ url: 'data:image/png;base64,BB', pixelRatio: 1 }
			],
			{ x: 3.6, y: -1 }
		);
		expect(values).toEqual([
			'image-set(url("data:image/png;base64,AA") 2x) 4 0, auto',
			'url("data:image/png;base64,BB") 4 0, auto'
		]);
	});
});

describe('the cursor crop', () => {
	/** A width x height RGBA image, opaque at the listed pixels. */
	function image(width: number, height: number, opaque: [number, number][]): Uint8Array {
		const rgba = new Uint8Array(width * height * 4);
		for (const [x, y] of opaque) {
			rgba[(y * width + x) * 4 + 3] = 255;
		}
		return rgba;
	}

	it('LC7: trims the padding around the shape, keeping the hotspot inside', () => {
		const size = { width: 64, height: 64 };
		// A KMS plane: a small arrow in the top-left corner, hotspot (0, 0).
		expect(
			cursorCrop(
				image(64, 64, [
					[0, 0],
					[10, 17]
				]),
				size,
				{ x: 0, y: 0 }
			)
		).toEqual({
			x: 0,
			y: 0,
			width: 11,
			height: 18
		});
		// An I-beam in the middle, its hotspot left of the pixels.
		expect(
			cursorCrop(
				image(64, 64, [
					[30, 20],
					[33, 40]
				]),
				size,
				{ x: 25, y: 30 }
			)
		).toEqual({
			x: 25,
			y: 20,
			width: 9,
			height: 21
		});
		// Fully transparent (a hidden cursor): one pixel at the hotspot.
		expect(cursorCrop(image(64, 64, []), size, { x: 5, y: 6 })).toEqual({
			x: 5,
			y: 6,
			width: 1,
			height: 1
		});
	});
});

describe('display and frame pixels', () => {
	it('LC4: map both ways, so the trackpad carries on from the reported cursor', () => {
		const display = { width: 1920, height: 1080 };
		const frame = { width: 960, height: 540 };
		expect(displayToFrame({ x: 200, y: 100 }, display, frame)).toEqual({ x: 100, y: 50 });
		expect(frameToDisplay({ x: 100, y: 50 }, frame, display)).toEqual({ x: 200, y: 100 });
		expect(frameToDisplay({ x: 2000, y: -5 }, frame, display)).toEqual({ x: 1919, y: 0 });
	});
});
