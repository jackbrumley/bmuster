/**
 * Where the full-screen controls button sits (SPEC-DESKTOP-FLOATING, option
 * A): on one of the four edges, at a place along it given as a fraction of
 * the space it can travel, so a rotated phone keeps it at the same place.
 * The expanded bar's place lives here too (SPEC-DESKTOP-FLOATING FB3–FB5);
 * `floating-memory.ts` keeps both in this browser.
 */
export type Edge = 'left' | 'right' | 'top' | 'bottom';

export type FloatingPosition = { edge: Edge; at: number };

export type Area = { width: number; height: number };

export const DEFAULT_POSITION: FloatingPosition = { edge: 'right', at: 0.5 };

/** The round button's size in page pixels (also in its stylesheet). */
export const BUTTON_SIZE = 48;

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

/**
 * The bar's place: how far across and down the room it can move in it
 * sits, from 0 to 1, so it stays inside the screen whatever the screen's
 * or the bar's size (the stylesheet places it the same way).
 */
export type BarPlace = { x: number; y: number };

export const DEFAULT_BAR: BarPlace = { x: 0.5, y: 0 };

function fractionOf(at: number, room: number): number {
	return room <= 0 ? 0 : Math.min(Math.max(at / room, 0), 1);
}

/** The bar's top-left corner inside the area. */
export function barCorner(place: BarPlace, area: Area, bar: Area): { x: number; y: number } {
	return {
		x: place.x * Math.max(area.width - bar.width, 0),
		y: place.y * Math.max(area.height - bar.height, 0)
	};
}

/** The place of a bar whose top-left corner is at `corner`, kept inside the area. */
export function barPlaceAt(corner: { x: number; y: number }, area: Area, bar: Area): BarPlace {
	return {
		x: fractionOf(corner.x, area.width - bar.width),
		y: fractionOf(corner.y, area.height - bar.height)
	};
}

/** The place after the arrow keys moved the bar by `delta` page pixels. */
export function nudged(
	place: BarPlace,
	delta: { x: number; y: number },
	area: Area,
	bar: Area
): BarPlace {
	const corner = barCorner(place, area, bar);
	return barPlaceAt({ x: corner.x + delta.x, y: corner.y + delta.y }, area, bar);
}

/**
 * The bar opened next to the button: level with it and starting at it,
 * running towards the middle of the screen, fitted inside it.
 */
export function barBeside(button: FloatingPosition, area: Area, bar: Area, size: number): BarPlace {
	const at = cornerOf(button, area, size);
	const leftHalf = at.x + size / 2 < area.width / 2;
	const topHalf = at.y + size / 2 < area.height / 2;
	return barPlaceAt(
		{
			x: leftHalf ? at.x : at.x + size - bar.width,
			y: topHalf ? at.y : at.y + size - bar.height
		},
		area,
		bar
	);
}

/**
 * Where the button goes when the bar collapses: at the bar's end nearer
 * the screen's edge, snapped to the nearest edge, so expanding it again
 * opens the bar where it was (`barBeside`).
 */
export function buttonBeside(
	place: BarPlace,
	area: Area,
	bar: Area,
	size: number
): FloatingPosition {
	const at = barCorner(place, area, bar);
	const leftHalf = at.x + bar.width / 2 < area.width / 2;
	const topHalf = at.y + bar.height / 2 < area.height / 2;
	return snapped(
		{
			x: leftHalf ? at.x : at.x + bar.width - size,
			y: topHalf ? at.y : at.y + bar.height - size
		},
		area,
		size
	);
}
