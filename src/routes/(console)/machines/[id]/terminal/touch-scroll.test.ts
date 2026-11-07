import { describe, expect, it } from 'vitest';
import {
	flingSpeed,
	LONG_PRESS_MS,
	MAX_FLING_SPEED,
	momentumStep,
	moveDrag,
	rowsFromPixels,
	startDrag,
	type Drag
} from './touch-scroll.ts';

const CELL = 20;

/** Moves the finger through the points (y, time), returning the rows scrolled and the last drag. */
function swipe(points: [number, number][]): { rows: number[]; captured: boolean[]; drag: Drag } {
	let drag = startDrag(100, 300, 0);
	const rows: number[] = [];
	const captured: boolean[] = [];
	for (const [y, time] of points) {
		const move = moveDrag(drag, 100, y, time, CELL);
		drag = move.drag;
		rows.push(move.rows);
		captured.push(move.captured);
	}
	return { rows, captured, drag };
}

describe('touch scrolling the terminal (T1, phones)', () => {
	it('turns pixels into whole rows and carries the rest to the next move', () => {
		expect(rowsFromPixels(0, 45, CELL)).toEqual({ rows: 2, remainderPx: 5 });
		expect(rowsFromPixels(5, 15, CELL)).toEqual({ rows: 1, remainderPx: 0 });
		expect(rowsFromPixels(0, -45, CELL)).toEqual({ rows: -2, remainderPx: -5 });
		expect(rowsFromPixels(0, 19, CELL)).toEqual({ rows: 0, remainderPx: 19 });
		expect(rowsFromPixels(7, 100, 0)).toEqual({ rows: 0, remainderPx: 0 });
	});

	it('leaves a tap alone: small movements neither scroll nor stop the page', () => {
		const { rows, captured, drag } = swipe([
			[303, 30],
			[296, 60]
		]);
		expect(rows).toEqual([0, 0]);
		expect(captured).toEqual([false, false]);
		expect(drag.phase).toBe('pending');
	});

	it('a finger moving down shows earlier output, counting from where it went down', () => {
		const { rows, captured } = swipe([
			[340, 16],
			[380, 32],
			[390, 48]
		]);
		expect(rows).toEqual([-2, -2, 0]);
		expect(captured).toEqual([true, true, true]);
	});

	it('a finger moving up shows later output', () => {
		const { rows } = swipe([[200, 16]]);
		expect(rows).toEqual([5]);
	});

	it('a finger that rests before moving is a long-press, left to the browser', () => {
		const { rows, captured, drag } = swipe([
			[301, 100],
			[360, LONG_PRESS_MS + 10],
			[420, LONG_PRESS_MS + 30]
		]);
		expect(rows).toEqual([0, 0, 0]);
		expect(captured).toEqual([false, false, false]);
		expect(drag.phase).toBe('press');
	});

	it('a flick keeps going, capped and slowing down until it stops', () => {
		const { drag } = swipe([
			[260, 10],
			[200, 20],
			[140, 30]
		]);
		const speed = flingSpeed(drag, 40);
		expect(speed).toBeGreaterThan(0);
		expect(speed).toBeLessThanOrEqual(MAX_FLING_SPEED);

		let velocity = speed;
		let distance = 0;
		let frames = 0;
		for (;;) {
			const step = momentumStep(velocity, 16);
			distance += step.distancePx;
			expect(Math.abs(step.velocity)).toBeLessThan(Math.abs(velocity));
			velocity = step.velocity;
			frames += 1;
			if (step.done) break;
		}
		expect(distance).toBeGreaterThan(0);
		expect(frames).toBeLessThan(200);
	});

	it('a finger that stopped before lifting, or a slow drag, does not fling', () => {
		const { drag } = swipe([
			[260, 10],
			[200, 20]
		]);
		expect(flingSpeed(drag, 500)).toBe(0);
		const slow = swipe([
			[290, 100],
			[289, 400]
		]);
		expect(flingSpeed(slow.drag, 401)).toBe(0);
		expect(flingSpeed(startDrag(0, 0, 0), 1)).toBe(0);
	});
});
