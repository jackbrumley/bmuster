import { contentBox, toPage, type Box, type Point, type Size } from './input.ts';

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

/** The CSS transform that draws the picture under `zoom`; none at 1x with no offset. */
export function zoomTransform(zoom: Zoom): string | undefined {
	return zoomed(zoom) || zoom.x !== 0 || zoom.y !== 0
		? `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})`
		: undefined;
}

export function sameZoom(a: Zoom, b: Zoom): boolean {
	return a.scale === b.scale && a.x === b.x && a.y === b.y;
}

/**
 * The part of the page where the picture shows under `zoom`: the unzoomed
 * box, less any letterbox bars of the enlarged picture.
 */
export function visibleArea(base: Box, zoom: Zoom, picture: Size): Box {
	const content = contentBox(zoomedBox(base, zoom), picture);
	const left = Math.max(base.left, content.left);
	const top = Math.max(base.top, content.top);
	const right = Math.min(base.left + base.width, content.left + content.width);
	const bottom = Math.min(base.top + base.height, content.top + content.height);
	return { left, top, width: Math.max(right - left, 0), height: Math.max(bottom - top, 0) };
}

/** Float noise (399.9999…) is not a pixel short. */
function snapped(value: number): number {
	const whole = Math.round(value);
	return Math.abs(value - whole) < 1e-6 ? whole : value;
}

/**
 * The trackpad pointer kept on screen (FA18): `point` (display pixels)
 * rounded and moved to the nearest display pixel that shows whole on the
 * page under `zoom`.
 */
export function clampToVisible(
	point: Point,
	base: Box,
	zoom: Zoom,
	picture: Size,
	display: Size
): Point {
	const area = visibleArea(base, zoom, picture);
	const content = contentBox(zoomedBox(base, zoom), picture);
	const axis = (
		value: number,
		start: number,
		size: number,
		from: number,
		along: number,
		pixels: number
	) => {
		const first = Math.ceil(snapped(((start - from) / along) * pixels));
		const last = Math.ceil(snapped(((start + size - from) / along) * pixels)) - 1;
		const low = Math.min(Math.max(first, 0), pixels - 1);
		const high = Math.min(Math.max(last, low), pixels - 1);
		return Math.min(Math.max(Math.round(value), low), high);
	};
	return {
		x: axis(point.x, area.left, area.width, content.left, content.width, display.width),
		y: axis(point.y, area.top, area.height, content.top, content.height, display.height)
	};
}

/** The share of the visible box, at each edge, where the pointer pans a zoomed picture. */
const EDGE_BAND = 0.25;
/** How fast the picture pans with the pointer at the very edge, in page pixels a second. */
export const EDGE_PAN_SPEED = 900;

/**
 * The edge pan's joystick (FA18): how fast the picture moves, in page
 * pixels a second, with the pointer at `pointer` on the page. Nothing in
 * the inner area (the dead zone); inside the outer quarter of the visible
 * area at an edge, towards that edge in proportion to the depth (full speed
 * at the edge and past it). The band is a share of the area on the page, so
 * it is the same at every zoom.
 */
export function edgeVelocity(area: Box, pointer: Point): Point {
	const axis = (at: number, start: number, size: number) => {
		const band = size * EDGE_BAND;
		if (band <= 0) {
			return 0;
		}
		const low = (start + band - at) / band;
		const high = (at - (start + size - band)) / band;
		// Near the left (top) edge the picture moves right (down), and the other way round.
		const depth = low > 0 ? Math.min(low, 1) : high > 0 ? -Math.min(high, 1) : 0;
		return depth * EDGE_PAN_SPEED;
	};
	return { x: axis(pointer.x, area.left, area.width), y: axis(pointer.y, area.top, area.height) };
}

/**
 * Edge pan under a finger (tap to click, FA18): the zoom after `elapsedMs`
 * with the pointer at `pointer` on the page. Nothing moves at 1x, in the
 * inner area, or past the picture's edges.
 */
export function edgePanned(
	zoom: Zoom,
	base: Box,
	picture: Size,
	pointer: Point,
	elapsedMs: number
): Zoom {
	if (!zoomed(zoom)) {
		return zoom;
	}
	const velocity = edgeVelocity(visibleArea(base, zoom, picture), pointer);
	return clampZoom(
		{
			scale: zoom.scale,
			x: zoom.x + (velocity.x * elapsedMs) / 1000,
			y: zoom.y + (velocity.y * elapsedMs) / 1000
		},
		base
	);
}

/** One frame of the trackpad's joystick: the new view and pointer, and the part-pixel left over. */
export type JoystickStep = { zoom: Zoom; pointer: Point; carry: Point };

/**
 * Edge pan as a joystick (trackpad, FA18): the step after `elapsedMs` with
 * the remote pointer at `pointer` (display pixels). The picture moves by
 * the joystick's speed and the pointer keeps its place on the page, so on
 * the machine it travels with the view, held button and all. Both move in
 * whole display pixels (the part-pixel is carried to the next frame), so
 * the pointer drawn at its display pixel never wobbles against the
 * picture. It stops at the picture's edge, and nothing moves at 1x or in
 * the dead zone.
 */
export function joystickPanned(
	zoom: Zoom,
	base: Box,
	picture: Size,
	display: Size,
	pointer: Point,
	elapsedMs: number,
	carry: Point
): JoystickStep {
	if (!zoomed(zoom)) {
		return { zoom, pointer, carry: { x: 0, y: 0 } };
	}
	const content = contentBox(zoomedBox(base, zoom), picture);
	const velocity = edgeVelocity(
		visibleArea(base, zoom, picture),
		toPage(pointer, zoomedBox(base, zoom), picture, display)
	);
	const axis = (
		offset: number,
		speed: number,
		at: number,
		left: number,
		perPage: number,
		size: number,
		pixels: number
	) => {
		if (speed === 0 || perPage <= 0) {
			return { offset, at, left: 0 };
		}
		// The picture moving right by m page pixels brings the pointer m page pixels' worth left on the display.
		const wanted = left - ((speed * elapsedMs) / 1000) * perPage;
		const lowest = Math.max(-at, Math.ceil(snapped(offset * perPage)));
		const highest = Math.min(
			pixels - 1 - at,
			Math.floor(snapped((offset - (size - size * zoom.scale)) * perPage))
		);
		const steps = Math.min(Math.max(Math.trunc(wanted), lowest), highest);
		const stopped = steps !== Math.trunc(wanted);
		return { offset: offset - steps / perPage, at: at + steps, left: stopped ? 0 : wanted - steps };
	};
	const x = axis(
		zoom.x,
		velocity.x,
		pointer.x,
		carry.x,
		display.width / content.width,
		base.width,
		display.width
	);
	const y = axis(
		zoom.y,
		velocity.y,
		pointer.y,
		carry.y,
		display.height / content.height,
		base.height,
		display.height
	);
	return {
		zoom: { scale: zoom.scale, x: x.offset, y: y.offset },
		pointer: { x: x.at, y: y.at },
		carry: { x: x.left, y: y.left }
	};
}
