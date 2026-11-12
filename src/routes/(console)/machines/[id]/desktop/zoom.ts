import type { Box, Point, Size } from './input.ts';

/**
 * Pinch zoom of the remote picture, in the browser only
 * (SPEC-DESKTOP-FLOATING, option A, 7). The picture is drawn
 * `translate(x, y) scale(scale)` from its top-left corner, so a point `p`
 * of the unzoomed picture box shows at `x + p * scale`. The zoom never
 * shows past the picture's edges: at 1x there is no offset, and zoomed in,
 * the enlarged box always covers the unzoomed one.
 */
export type Zoom = { scale: number; x: number; y: number };

export const NO_ZOOM: Zoom = { scale: 1, x: 0, y: 0 };

export const MAX_ZOOM = 5;

export function zoomed(zoom: Zoom): boolean {
	return zoom.scale > 1;
}

/** Where the picture box is drawn on the page under `zoom`. */
export function zoomedBox(base: Box, zoom: Zoom): Box {
	return {
		left: base.left + zoom.x,
		top: base.top + zoom.y,
		width: base.width * zoom.scale,
		height: base.height * zoom.scale
	};
}

/** Keeps the scale within 1x–5x and the enlarged box over the whole unzoomed one. */
export function clampZoom(zoom: Zoom, base: Size): Zoom {
	const scale = Math.min(Math.max(zoom.scale, 1), MAX_ZOOM);
	const clamp = (offset: number, size: number) =>
		Math.min(Math.max(offset, size - size * scale), 0);
	return { scale, x: clamp(zoom.x, base.width), y: clamp(zoom.y, base.height) };
}

/** Two fingers: where they meet in the middle and how far apart they are. */
export type Pinch = { mid: Point; distance: number };

export function pinchOf(a: Point, b: Point): Pinch {
	return {
		mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
		distance: Math.hypot(a.x - b.x, a.y - b.y)
	};
}

/**
 * The zoom after two fingers went from `from` to `to`, starting at `start`:
 * the scale follows the change in distance, and the point of the picture
 * that was under the fingers' midpoint stays under it (so moving both
 * fingers pans).
 */
export function pinched(start: Zoom, from: Pinch, to: Pinch, base: Box): Zoom {
	const ratio = from.distance > 0 ? to.distance / from.distance : 1;
	const scale = Math.min(Math.max(start.scale * ratio, 1), MAX_ZOOM);
	const localX = (from.mid.x - base.left - start.x) / start.scale;
	const localY = (from.mid.y - base.top - start.y) / start.scale;
	return clampZoom(
		{ scale, x: to.mid.x - base.left - localX * scale, y: to.mid.y - base.top - localY * scale },
		base
	);
}

/** The CSS transform that draws the picture under `zoom`; none at 1x. */
export function zoomTransform(zoom: Zoom): string | undefined {
	return zoomed(zoom) ? `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})` : undefined;
}
