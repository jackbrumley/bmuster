/**
 * Swiping the terminal on a phone (SPEC-SESSIONS T1): the arithmetic behind
 * it, kept free of the DOM so it can be tested. A finger that moves less than
 * a few pixels is a tap (it focuses the terminal); one that rests before it
 * moves is a long-press, left to the browser; any other drag scrolls, one row
 * per cell height, and a flick keeps going and slows down.
 */

/** Movement under this is still a tap. */
const TAP_SLOP_PX = 8;
/** A finger that rests this long before moving is a long-press, not a swipe. */
export const LONG_PRESS_MS = 450;
/** Momentum ends below this speed (pixels per millisecond). */
const MIN_FLING_SPEED = 0.03;
/** A flick faster than this is capped, so one flick never jumps the whole history. */
export const MAX_FLING_SPEED = 6;
/** The speed kept per 16 ms frame of momentum. */
const FRICTION_PER_FRAME = 0.95;
/** A finger that stopped this long before lifting does not fling. */
const FLING_STALE_MS = 80;

type Point = { x: number; y: number; time: number };

export type Drag =
	| { phase: 'pending'; start: Point; last: Point }
	| { phase: 'scroll'; last: Point; remainderPx: number; velocity: number }
	| { phase: 'press'; last: Point };

export type Move = {
	drag: Drag;
	/** Rows to scroll: positive shows later output, negative earlier. */
	rows: number;
	/** True while the drag is a scroll, so the page must not move. */
	captured: boolean;
};

export function startDrag(x: number, y: number, time: number): Drag {
	const point = { x, y, time };
	return { phase: 'pending', start: point, last: point };
}

/**
 * Whole rows in a distance plus what was left over last time; the rest is
 * carried to the next move so slow drags still add up. A finger moving up
 * (a positive distance) shows later output, as on any phone list.
 */
export function rowsFromPixels(
	remainderPx: number,
	deltaPx: number,
	cellHeight: number
): { rows: number; remainderPx: number } {
	if (cellHeight <= 0) {
		return { rows: 0, remainderPx: 0 };
	}
	const total = remainderPx + deltaPx;
	const whole = Math.trunc(total / cellHeight);
	// Never -0: callers compare rows with 0.
	const rows = whole === 0 ? 0 : whole;
	return { rows, remainderPx: total - rows * cellHeight };
}

export function moveDrag(drag: Drag, x: number, y: number, time: number, cellHeight: number): Move {
	const point = { x, y, time };
	switch (drag.phase) {
		case 'press':
			return { drag: { phase: 'press', last: point }, rows: 0, captured: false };
		case 'pending': {
			const distance = Math.hypot(x - drag.start.x, y - drag.start.y);
			if (distance < TAP_SLOP_PX) {
				return { drag: { ...drag, last: point }, rows: 0, captured: false };
			}
			if (time - drag.start.time >= LONG_PRESS_MS) {
				return { drag: { phase: 'press', last: point }, rows: 0, captured: false };
			}
			// The slop is not lost: the scroll starts from where the finger went down.
			return scrollBy(
				{ phase: 'scroll', last: drag.start, remainderPx: 0, velocity: 0 },
				point,
				cellHeight
			);
		}
		case 'scroll':
			return scrollBy(drag, point, cellHeight);
	}
}

function scrollBy(
	drag: Extract<Drag, { phase: 'scroll' }>,
	point: Point,
	cellHeight: number
): Move {
	const delta = drag.last.y - point.y;
	const elapsed = Math.max(1, point.time - drag.last.time);
	const step = rowsFromPixels(drag.remainderPx, delta, cellHeight);
	// Smoothed, so one jittery sample does not decide the flick.
	const velocity = 0.8 * (delta / elapsed) + 0.2 * drag.velocity;
	return {
		drag: { phase: 'scroll', last: point, remainderPx: step.remainderPx, velocity },
		rows: step.rows,
		captured: true
	};
}

/**
 * The speed a lifted finger leaves behind (pixels per millisecond, positive
 * towards later output), or 0 when there is no flick: not a scroll, a finger
 * that stopped before lifting, or one too slow to matter.
 */
export function flingSpeed(drag: Drag, time: number): number {
	if (drag.phase !== 'scroll' || time - drag.last.time > FLING_STALE_MS) {
		return 0;
	}
	if (Math.abs(drag.velocity) < MIN_FLING_SPEED) {
		return 0;
	}
	return Math.max(-MAX_FLING_SPEED, Math.min(MAX_FLING_SPEED, drag.velocity));
}

/** One frame of momentum: how far it goes in `elapsedMs`, and the slower speed after it. */
export function momentumStep(
	velocity: number,
	elapsedMs: number
): { distancePx: number; velocity: number; done: boolean } {
	const next = velocity * FRICTION_PER_FRAME ** (elapsedMs / 16);
	return {
		distancePx: velocity * elapsedMs,
		velocity: next,
		done: Math.abs(next) < MIN_FLING_SPEED
	};
}
