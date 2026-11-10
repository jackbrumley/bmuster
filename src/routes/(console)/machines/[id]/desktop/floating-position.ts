import { z } from 'zod';

/**
 * Where the full-screen controls button sits (SPEC-DESKTOP-FLOATING): on
 * the left or right edge, at a height given as a fraction of the space it
 * can travel, so a rotated phone keeps it at the same place. Kept in this
 * browser only; storage can be blocked (private windows, site data off),
 * and then the button starts at the default place.
 */
type Side = 'left' | 'right';

export type FloatingPosition = { side: Side; at: number };

export const DEFAULT_POSITION: FloatingPosition = { side: 'right', at: 0.5 };

/** A press that moves less than this (page pixels) is a tap, not a drag. */
export const DRAG_THRESHOLD_PX = 8;

const STORAGE_KEY = 'bmuster.desktop.floatingButton';

const stored = z.object({ side: z.enum(['left', 'right']), at: z.number().min(0).max(1) });

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

/**
 * Where a button let go with its top-left corner at `corner` (inside an
 * area of `area` size) snaps to: the nearer side edge, at the same height.
 */
export function snapped(
	corner: { x: number; y: number },
	area: { width: number; height: number },
	size: number
): FloatingPosition {
	const side: Side = corner.x + size / 2 < area.width / 2 ? 'left' : 'right';
	const travel = area.height - size;
	if (travel <= 0) {
		return { side, at: DEFAULT_POSITION.at };
	}
	return { side, at: Math.min(Math.max(corner.y / travel, 0), 1) };
}

/** Keeps a dragged button's corner inside the area. */
export function clampCorner(
	corner: { x: number; y: number },
	area: { width: number; height: number },
	size: number
): { x: number; y: number } {
	return {
		x: Math.min(Math.max(corner.x, 0), Math.max(area.width - size, 0)),
		y: Math.min(Math.max(corner.y, 0), Math.max(area.height - size, 0))
	};
}
