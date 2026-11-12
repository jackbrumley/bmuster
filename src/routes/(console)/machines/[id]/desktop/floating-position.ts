import { z } from 'zod';

/**
 * Where the full-screen controls button sits (SPEC-DESKTOP-FLOATING, option
 * A): on one of the four edges, at a place along it given as a fraction of
 * the space it can travel, so a rotated phone keeps it at the same place.
 * Kept in this browser only; storage can be blocked (private windows, site
 * data off), and then the button starts at the default place.
 */
export type Edge = 'left' | 'right' | 'top' | 'bottom';

export type FloatingPosition = { edge: Edge; at: number };

export type Area = { width: number; height: number };

export const DEFAULT_POSITION: FloatingPosition = { edge: 'right', at: 0.5 };

/** A press that moves less than this (page pixels) is a tap, not a drag. */
export const DRAG_THRESHOLD_PX = 8;

const STORAGE_KEY = 'bmuster.desktop.floatingButton';

const fraction = z.number().min(0).max(1);

const stored = z.union([
	z.object({ edge: z.enum(['left', 'right', 'top', 'bottom']), at: fraction }),
	// Saved before the button could sit on the top or bottom edge: the same place, read as an edge.
	z
		.object({ side: z.enum(['left', 'right']), at: fraction })
		.transform(({ side, at }): FloatingPosition => ({ edge: side, at }))
]);

export function readPosition(): FloatingPosition {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw === null) {
			return DEFAULT_POSITION;
		}
		const parsed = stored.safeParse(JSON.parse(raw));
		return parsed.success ? parsed.data : DEFAULT_POSITION;
	} catch {
		return DEFAULT_POSITION;
	}
}

export function savePosition(position: FloatingPosition): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(position));
	} catch {
		// A per-viewer convenience; the button just starts at the default next time.
	}
}

/** The left and right edges run up and down; `at` is then a height. */
export function upright(edge: Edge): edge is 'left' | 'right' {
	return edge === 'left' || edge === 'right';
}

/**
 * Where a button let go with its top-left corner at `corner` (inside an
 * area of `area` size) snaps to: the nearest of the four edges, at the same
 * place along it. Ties go to the side edges.
 */
export function snapped(
	corner: { x: number; y: number },
	area: Area,
	size: number
): FloatingPosition {
	const travelX = area.width - size;
	const travelY = area.height - size;
	const distances: readonly (readonly [Edge, number])[] = [
		['left', corner.x],
		['right', travelX - corner.x],
		['top', corner.y],
		['bottom', travelY - corner.y]
	];
	const [edge] = distances.reduce((best, next) => (next[1] < best[1] ? next : best));
	const travel = upright(edge) ? travelY : travelX;
	const along = upright(edge) ? corner.y : corner.x;
	if (travel <= 0) {
		return { edge, at: DEFAULT_POSITION.at };
	}
	return { edge, at: Math.min(Math.max(along / travel, 0), 1) };
}

/** The top-left corner of a button resting at `position`. */
export function cornerOf(
	position: FloatingPosition,
	area: Area,
	size: number
): { x: number; y: number } {
	const travelX = Math.max(area.width - size, 0);
	const travelY = Math.max(area.height - size, 0);
	switch (position.edge) {
		case 'left':
			return { x: 0, y: travelY * position.at };
		case 'right':
			return { x: travelX, y: travelY * position.at };
		case 'top':
			return { x: travelX * position.at, y: 0 };
		case 'bottom':
			return { x: travelX * position.at, y: travelY };
	}
}

/** Keeps a dragged button's corner inside the area. */
export function clampCorner(
	corner: { x: number; y: number },
	area: Area,
	size: number
): { x: number; y: number } {
	return {
		x: Math.min(Math.max(corner.x, 0), Math.max(area.width - size, 0)),
		y: Math.min(Math.max(corner.y, 0), Math.max(area.height - size, 0))
	};
}
