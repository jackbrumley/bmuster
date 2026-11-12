import { contentBox, toDisplay, type Box, type Point, type Size } from './input.ts';
import { MAX_ZOOM, zoomedBox, type Zoom } from './zoom.ts';

/**
 * The fixed cursor touch mode (SPEC-DESKTOP-FLOATING FA22–FA24): the remote
 * pointer stays at the centre of the stage and a finger moves the picture
 * under it, like a map. Unlike the other modes the picture may move past
 * its edges (the stage's background shows beyond it), as far as it takes
 * to bring any point of the picture, corners included, under the centre.
 * Same `Zoom` as zoom.ts: the picture box drawn `translate(x, y) scale(s)`.
 */

/** The middle of the visible box, on the page. */
export function centreOf(base: Box): Point {
	return { x: base.left + base.width / 2, y: base.top + base.height / 2 };
}

/** The picture's place inside the unzoomed box, measured from the box's corner. */
function localContent(base: Size, picture: Size): Box {
	return contentBox({ left: 0, top: 0, width: base.width, height: base.height }, picture);
}

/**
 * Keeps the scale within 1x–5x and the centre of the box over the picture:
 * the picture may move until its edge (letterbox bars aside) reaches the
 * centre, so for a picture that fills the box, half the box each way.
 */
export function clampFixed(zoom: Zoom, base: Size, picture: Size): Zoom {
	const scale = Math.min(Math.max(zoom.scale, 1), MAX_ZOOM);
	const content = localContent(base, picture);
	const clamp = (offset: number, half: number, start: number, size: number) =>
		Math.min(Math.max(offset, half - (start + size) * scale), half - start * scale);
	return {
		scale,
		x: clamp(zoom.x, base.width / 2, content.left, content.width),
		y: clamp(zoom.y, base.height / 2, content.top, content.height)
	};
}

/** The display pixel under the centre of the box: where the remote pointer is. */
export function underCentre(zoom: Zoom, base: Box, picture: Size, display: Size): Point {
	return toDisplay(centreOf(base), zoomedBox(base, zoom), picture, display);
}

/** The view at `scale` with the display pixel `point` under the centre of the box. */
export function centredOn(
	scale: number,
	point: Point,
	base: Box,
	picture: Size,
	display: Size
): Zoom {
	const content = localContent(base, picture);
	const at = Math.min(Math.max(scale, 1), MAX_ZOOM);
	const x = content.left + (point.x / display.width) * content.width;
	const y = content.top + (point.y / display.height) * content.height;
	return clampFixed(
		{ scale: at, x: base.width / 2 - x * at, y: base.height / 2 - y * at },
		base,
		picture
	);
}

/** A finger moved the picture by `dx`, `dy` page pixels. */
export function dragged(zoom: Zoom, dx: number, dy: number, base: Size, picture: Size): Zoom {
	return clampFixed({ scale: zoom.scale, x: zoom.x + dx, y: zoom.y + dy }, base, picture);
}
