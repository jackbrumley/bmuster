import { contentBox, type Box, type Point, type Size } from './input.ts';

/**
 * Pinch zoom of the remote picture, in the browser only
 * (SPEC-DESKTOP-FLOATING, option A, 7). The picture is drawn
 * `translate(x, y) scale(scale)` from its top-left corner, so a point `p`
 * of the unzoomed picture box shows at `x + p * scale`. Outside the fixed
 * cursor mode the view never shows past the picture's edges (FA18): on an
 * axis where the enlarged picture is wider (taller) than the box it covers
 * the box, and on an axis where it fits it is centred and never pans.
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

/** The picture's place inside the unzoomed box, measured from the box's corner. */
export function localContent(base: Size, picture: Size): Box {
	return contentBox({ left: 0, top: 0, width: base.width, height: base.height }, picture);
}

/** Float noise in a size comparison is not a pixel of picture. */
const FIT_TOLERANCE = 1e-6;

/** Whether the picture, `length` long from `start` in a box `size` long, overflows the box at `scale`. */
function overflows(scale: number, size: number, length: number): boolean {
	return length * scale > size + FIT_TOLERANCE;
}

/**
 * One axis of the hard limit: an overflowing picture covers the box (its
 * edges never come inside it); a picture that fits sits centred.
 */
function clampOffset(
	offset: number,
	scale: number,
	size: number,
	start: number,
	length: number
): number {
	if (!overflows(scale, size, length)) {
		return size / 2 - (start + length / 2) * scale;
	}
	// `0 - …` rather than `-…`, so an offset at the edge is never negative zero.
	return Math.min(Math.max(offset, size - (start + length) * scale), 0 - start * scale);
}

/** The axes the view can pan along at this zoom: those where the picture is bigger than the box. */
export function pannable(scale: number, base: Size, picture: Size): { x: boolean; y: boolean } {
	const content = localContent(base, picture);
	return {
		x: overflows(scale, base.width, content.width),
		y: overflows(scale, base.height, content.height)
	};
}

/**
 * The hard limit, applied after every pan, zoom and pinch (FA18): the scale
 * within 1x–5x, and on each axis the picture either covering the box or,
 * where it fits, centred.
 */
export function clampZoom(zoom: Zoom, base: Size, picture: Size): Zoom {
	const scale = Math.min(Math.max(zoom.scale, 1), MAX_ZOOM);
	const content = localContent(base, picture);
	return {
		scale,
		x: clampOffset(zoom.x, scale, base.width, content.left, content.width),
		y: clampOffset(zoom.y, scale, base.height, content.top, content.height)
	};
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
export function pinched(start: Zoom, from: Pinch, to: Pinch, base: Box, picture: Size): Zoom {
	const ratio = from.distance > 0 ? to.distance / from.distance : 1;
	const scale = Math.min(Math.max(start.scale * ratio, 1), MAX_ZOOM);
	const localX = (from.mid.x - base.left - start.x) / start.scale;
	const localY = (from.mid.y - base.top - start.y) / start.scale;
	return clampZoom(
		{ scale, x: to.mid.x - base.left - localX * scale, y: to.mid.y - base.top - localY * scale },
		base,
		picture
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

/** The share of the visible box, at each edge, where a finger in tap to click pans a zoomed picture. */
const EDGE_BAND = 0.25;
/** How fast the picture pans with the finger at the very edge, in page pixels a second. */
export const EDGE_PAN_SPEED = 900;

/**
 * Tap to click's edge pan (FA18): how fast the picture moves, in page
 * pixels a second, with the finger at `pointer` on the page. Nothing in the
 * inner area; inside the outer quarter of the visible area at an edge,
 * towards that edge in proportion to the depth (full speed at the edge).
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
 * with the finger at `pointer` on the page, inside the hard limit (so never
 * along an axis where the picture fits, or past its edges).
 */
export function edgePanned(
	zoom: Zoom,
	base: Box,
	picture: Size,
	pointer: Point,
	elapsedMs: number
): Zoom {
	const velocity = edgeVelocity(visibleArea(base, zoom, picture), pointer);
	return clampZoom(
		{
			scale: zoom.scale,
			x: zoom.x + (velocity.x * elapsedMs) / 1000,
			y: zoom.y + (velocity.y * elapsedMs) / 1000
		},
		base,
		picture
	);
}

/** The trackpad's push margin: this share of the visible area at each edge of a pannable axis. */
const PUSH_MARGIN = 0.1;
/** A finger held still this long, with the pointer in the margin, starts the creep. */
const CREEP_DELAY_MS = 300;
/** The creep's speed when it starts, in page pixels a second. */
const CREEP_START_SPEED = 120;
/** The creep's top speed, in page pixels a second. */
const CREEP_TOP_SPEED = 600;
/** How long the creep takes to ramp from its start speed to its top speed. */
const CREEP_RAMP_MS = 1500;
/** A pointer this close to the margin's inner line (page pixels) is in the margin. */
const LINE_TOLERANCE = 0.5;

/** The view and the remote pointer (display pixels) after a push or a creep. */
export type View = { zoom: Zoom; pointer: Point };

/** One axis of the view, in page pixels, for the push and the creep. */
type Axis = {
	offset: number;
	scale: number;
	/** Where the unzoomed box starts on the page. */
	boxStart: number;
	/** The picture inside the unzoomed box. */
	start: number;
	length: number;
	/** Display pixels along this axis. */
	pixels: number;
	pans: boolean;
	/** The margin's inner lines: the pointer pushes the view past these. */
	low: number;
	high: number;
	/** The offsets with the picture's far and near edges at the box's edges. */
	lowest: number;
	highest: number;
};

/** The box, picture, display and visible area along one axis. */
type Extent = {
	offset: number;
	boxStart: number;
	boxSize: number;
	start: number;
	length: number;
	pixels: number;
	areaStart: number;
	areaSize: number;
	pans: boolean;
};

function axisOf(scale: number, extent: Extent): Axis {
	return {
		offset: extent.offset,
		scale,
		boxStart: extent.boxStart,
		start: extent.start,
		length: extent.length,
		pixels: extent.pixels,
		pans: extent.pans,
		low: extent.areaStart + extent.areaSize * PUSH_MARGIN,
		high: extent.areaStart + extent.areaSize * (1 - PUSH_MARGIN),
		lowest: extent.boxSize - (extent.start + extent.length) * scale,
		highest: 0 - extent.start * scale
	};
}

function axesOf(zoom: Zoom, base: Box, picture: Size, display: Size): { x: Axis; y: Axis } {
	const content = localContent(base, picture);
	const area = visibleArea(base, zoom, picture);
	const pans = pannable(zoom.scale, base, picture);
	return {
		x: axisOf(zoom.scale, {
			offset: zoom.x,
			boxStart: base.left,
			boxSize: base.width,
			start: content.left,
			length: content.width,
			pixels: display.width,
			areaStart: area.left,
			areaSize: area.width,
			pans: pans.x
		}),
		y: axisOf(zoom.scale, {
			offset: zoom.y,
			boxStart: base.top,
			boxSize: base.height,
			start: content.top,
			length: content.height,
			pixels: display.height,
			areaStart: area.top,
			areaSize: area.height,
			pans: pans.y
		})
	};
}

/** Where display pixel `pixel` shows on the page with the view at `offset`. */
function pageOf(axis: Axis, pixel: number, offset: number): number {
	return axis.boxStart + offset + (axis.start + (pixel / axis.pixels) * axis.length) * axis.scale;
}

/** The view offset that shows display pixel `pixel` at `page`. */
function offsetFor(axis: Axis, pixel: number, page: number): number {
	return page - axis.boxStart - (axis.start + (pixel / axis.pixels) * axis.length) * axis.scale;
}

/** Display pixels per page pixel along `axis`. */
function perPage(axis: Axis): number {
	const length = axis.length * axis.scale;
	return length > 0 ? axis.pixels / length : 1;
}

/**
 * The trackpad's push (FA18): a finger moved `move` page pixels. The remote
 * pointer moves by the whole movement. On a pannable axis, a pointer that
 * would go past the margin's inner line pans the view by exactly the
 * overflow, so it stays on the line (or where it already was, deeper in the
 * margin); moving back inward moves it at once, with no pan. On an axis
 * where the picture fits nothing pans. The view stays inside the hard limit
 * and the pointer on the visible picture.
 */
export function pushed(
	zoom: Zoom,
	base: Box,
	picture: Size,
	display: Size,
	pointer: Point,
	move: Point
): View {
	const from = clampToVisible(pointer, base, zoom, picture, display);
	const axes = axesOf(zoom, base, picture, display);
	const axis = (line: Axis, at: number, by: number) => {
		const to = Math.min(Math.max(Math.round(at + by * perPage(line)), 0), line.pixels - 1);
		if (!line.pans) {
			return { offset: line.offset, to };
		}
		const was = pageOf(line, at, line.offset);
		const now = pageOf(line, to, line.offset);
		const high = Math.max(line.high, was);
		const low = Math.min(line.low, was);
		const held = now > high ? high : now < low ? low : undefined;
		return { offset: held === undefined ? line.offset : offsetFor(line, to, held), to };
	};
	const x = axis(axes.x, from.x, move.x);
	const y = axis(axes.y, from.y, move.y);
	const next = clampZoom({ scale: zoom.scale, x: x.offset, y: y.offset }, base, picture);
	return {
		zoom: next,
		pointer: clampToVisible({ x: x.to, y: y.to }, base, next, picture, display)
	};
}

/**
 * The creep's speed in page pixels a second (FA18) with the finger still
 * for `stillMs`: none before `CREEP_DELAY_MS`, then from the start speed up
 * to the top speed over `CREEP_RAMP_MS`.
 */
export function creepSpeed(stillMs: number): number {
	if (stillMs < CREEP_DELAY_MS) {
		return 0;
	}
	const ramp = Math.min((stillMs - CREEP_DELAY_MS) / CREEP_RAMP_MS, 1);
	return CREEP_START_SPEED + (CREEP_TOP_SPEED - CREEP_START_SPEED) * ramp;
}

/** One frame of the creep: the view, the pointer and the part-pixel left over. */
export type CreepStep = View & { carry: Point };

/** Which way the view creeps along `line` with the pointer at `page`: towards the far edge, the near one, or not. */
function creepDirection(line: Axis, page: number): number {
	if (!line.pans) {
		return 0;
	}
	if (page >= line.high - LINE_TOLERANCE && line.offset > line.lowest + FIT_TOLERANCE) {
		return 1;
	}
	if (page <= line.low + LINE_TOLERANCE && line.offset < line.highest - FIT_TOLERANCE) {
		return -1;
	}
	return 0;
}

/**
 * One frame of the creep (FA18): with the finger still for `stillMs` and
 * the pointer in the margin of a pannable axis, the view moves towards that
 * edge by `elapsedMs` worth of `creepSpeed`, and the remote pointer moves
 * with it, so it keeps its place on the screen. The pointer moves in whole
 * display pixels and the view to match, carrying the part-pixel to the next
 * frame, so the drawn cursor never wobbles. Nothing creeps on an axis where
 * the picture fits, outside the margin, or past the picture's edge.
 */
export function crept(
	zoom: Zoom,
	base: Box,
	picture: Size,
	display: Size,
	pointer: Point,
	stillMs: number,
	elapsedMs: number,
	carry: Point
): CreepStep {
	const speed = creepSpeed(stillMs);
	const axes = axesOf(zoom, base, picture, display);
	const axis = (line: Axis, at: number, left: number) => {
		const page = pageOf(line, at, line.offset);
		// Towards the right (bottom) edge the pointer's pixel grows and the view moves left (up).
		const towards = creepDirection(line, page);
		if (speed === 0 || towards === 0) {
			return { offset: line.offset, at, left: 0 };
		}
		const wanted = left + ((speed * elapsedMs) / 1000) * perPage(line);
		const steps = Math.trunc(wanted);
		const to = Math.min(Math.max(at + towards * steps, 0), line.pixels - 1);
		return { offset: offsetFor(line, to, page), at: to, left: wanted - steps };
	};
	const x = axis(axes.x, pointer.x, carry.x);
	const y = axis(axes.y, pointer.y, carry.y);
	const next = clampZoom({ scale: zoom.scale, x: x.offset, y: y.offset }, base, picture);
	return {
		zoom: next,
		pointer: clampToVisible({ x: x.at, y: y.at }, base, next, picture, display),
		carry: { x: x.left, y: y.left }
	};
}
