import type { Point } from './input.ts';

/**
 * The local cursor (SPEC-DESKTOP 22): which cursor the viewer sees, and
 * where. Pure, so the rules are tested without a browser.
 *
 * - A mouse controlling the machine gets the remote cursor's shape as its
 *   own CSS cursor: the viewer's computer draws it at full rate, with no
 *   round trip. The agent's reported cursor is drawn on the cursor canvas
 *   only when the remote pointer moved without our input.
 * - Touch draws the cursor on the canvas where we last sent the pointer,
 *   at once, and snaps to the reported position once the fingers rest.
 * - A watch-only session always draws the reported cursor and never
 *   changes the CSS cursor.
 *
 * Points are in the stream's (encoded-frame) pixels, as the agent reports
 * the cursor (SPEC-DESKTOP 4.2).
 */

/** After this long without our input, the agent's reported cursor counts again. */
export const SETTLE_MS = 500;
/** The reported and sent positions differ by more than this (frame pixels) before they disagree. */
const DRIFT_PX = 4;
/**
 * The largest CSS cursor, in CSS pixels. Browsers cap cursor images
 * (128 px), and Chromium drops one over 32 px where it would cross the
 * browser's own frame, so anything bigger is drawn on the canvas.
 */
export const MAX_CSS_CURSOR = 32;

/** Where the agent says the cursor is; `visible` false when it is hidden or off this display. */
type Reported = Point & { visible: boolean };

/** The kind of the viewer's last input on the picture. */
export type InputKind = 'mouse' | 'touch';

export type CursorState = {
	/** This session sends input (a control session, live). */
	controlling: boolean;
	kind: InputKind;
	/**
	 * The agent has sent a cursor shape since the last hello. An agent whose
	 * picture carries the cursor (the Wayland portal, a compositor drawing
	 * its own) sends none, and the viewer's cursor is left alone.
	 */
	reportsCursor: boolean;
	reported: Reported | undefined;
	/** Where we last sent the pointer. */
	sent: Point | undefined;
	/** A mouse is over the picture itself (not a control laid over it). */
	over: boolean;
	/** Milliseconds since our last pointer input. */
	sinceInput: number;
	/** The remote shape fits a CSS cursor at the shown size. */
	fits: boolean;
};

/** The stage's CSS cursor: left alone, hidden, or the remote shape. */
export type CssCursor = 'default' | 'none' | 'image';

type CanvasCursor = { kind: 'none' } | { kind: 'at'; x: number; y: number };

export type CursorPlan = { css: CssCursor; canvas: CanvasCursor };

const NOTHING: CanvasCursor = { kind: 'none' };

function at(point: Point): CanvasCursor {
	return { kind: 'at', x: point.x, y: point.y };
}

/** The two positions are further apart than rounding and stream scaling explain. */
function drifted(a: Point, b: Point): boolean {
	return Math.hypot(a.x - b.x, a.y - b.y) > DRIFT_PX;
}

/**
 * The reported cursor moved without our input: we have sent nothing for
 * `SETTLE_MS` and it is somewhere else than where we sent it (someone at
 * the machine, or a program moving the pointer).
 */
export function movedByItself(state: CursorState, reported: Point): boolean {
	return (
		state.sinceInput >= SETTLE_MS && (state.sent === undefined || drifted(state.sent, reported))
	);
}

export function planCursor(state: CursorState): CursorPlan {
	const reported = state.reported;
	const shown = reported?.visible === true ? at(reported) : NOTHING;
	if (!state.controlling || !state.reportsCursor) {
		return { css: 'default', canvas: shown };
	}
	// Controls laid over the picture, and the touch screen, keep their own cursor.
	const mouseOver = state.kind === 'mouse' && state.over;
	if (reported?.visible !== true) {
		// Hidden at the machine (a game, a full-screen video): hidden here too.
		return { css: mouseOver ? 'none' : 'default', canvas: NOTHING };
	}
	const settled = movedByItself(state, reported);
	if (state.kind === 'touch') {
		return { css: 'default', canvas: settled || state.sent === undefined ? shown : at(state.sent) };
	}
	if (!mouseOver) {
		return { css: 'default', canvas: shown };
	}
	if (state.fits) {
		return { css: 'image', canvas: settled ? shown : NOTHING };
	}
	// Too big for a CSS cursor: drawn on the canvas where we sent the pointer.
	return { css: 'none', canvas: settled || state.sent === undefined ? shown : at(state.sent) };
}

/**
 * CSS pixels per cursor image pixel: the shape is drawn at one stream
 * pixel per image pixel (as on the cursor canvas), then shown at the
 * picture's scale and zoom.
 */
export function cursorScale(shownWidth: number, frameWidth: number, zoom: number): number {
	return frameWidth > 0 ? (shownWidth / frameWidth) * zoom : 1;
}

export type CursorSize = { width: number; height: number };

/** The CSS cursor's size at `scale`, or undefined when it is too big for one (or empty). */
export function cssCursorSize(image: CursorSize, scale: number): CursorSize | undefined {
	const width = Math.round(image.width * scale);
	const height = Math.round(image.height * scale);
	if (width < 1 || height < 1 || width > MAX_CSS_CURSOR || height > MAX_CSS_CURSOR) {
		return undefined;
	}
	return { width, height };
}

/** A cursor picture: its URL and how many of its pixels make one CSS pixel. */
export type CursorPicture = { url: string; pixelRatio: number };

/**
 * The CSS `cursor` values for `pictures`, best first, with the hotspot in
 * CSS pixels: a sharp picture through `image-set`, a plain one through
 * `url()` for a browser that refuses `image-set`. Each falls back to the
 * viewer's own arrow if the picture cannot be used.
 */
export function cssCursorValues(pictures: readonly CursorPicture[], hotspot: Point): string[] {
	const x = Math.max(0, Math.round(hotspot.x));
	const y = Math.max(0, Math.round(hotspot.y));
	return pictures.map(({ url, pixelRatio }) =>
		pixelRatio === 1
			? `url("${url}") ${x} ${y}, auto`
			: `image-set(url("${url}") ${pixelRatio}x) ${x} ${y}, auto`
	);
}

/** A frame point to the display's pixels (the inverse of how input is sent). */
export function frameToDisplay(point: Point, frame: CursorSize, display: CursorSize): Point {
	const along = (value: number, from: number, to: number) =>
		from > 0 ? Math.min(Math.max(Math.round((value * to) / from), 0), to - 1) : value;
	return {
		x: along(point.x, frame.width, display.width),
		y: along(point.y, frame.height, display.height)
	};
}

/** A display point (as sent) to the frame's pixels, where the cursor is drawn. */
export function displayToFrame(point: Point, display: CursorSize, frame: CursorSize): Point {
	const along = (value: number, from: number, to: number) =>
		from > 0 ? (value * to) / from : value;
	return {
		x: along(point.x, display.width, frame.width),
		y: along(point.y, display.height, frame.height)
	};
}

export type Crop = { x: number; y: number; width: number; height: number };

/**
 * The part of a cursor image worth showing: the box around its pixels that
 * are not fully transparent, grown to take in the hotspot. Cursor images
 * come padded (a KMS cursor plane is 64 or 256 pixels square around a small
 * arrow), and the padding alone would push a cursor over the CSS limit.
 * `rgba` is the image's pixels, four bytes each.
 */
export function cursorCrop(rgba: ArrayLike<number>, size: CursorSize, hotspot: Point): Crop {
	let left = Math.min(Math.max(hotspot.x, 0), size.width - 1);
	let top = Math.min(Math.max(hotspot.y, 0), size.height - 1);
	let right = left;
	let bottom = top;
	for (let y = 0; y < size.height; y += 1) {
		for (let x = 0; x < size.width; x += 1) {
			if ((rgba[(y * size.width + x) * 4 + 3] ?? 0) > 0) {
				left = Math.min(left, x);
				top = Math.min(top, y);
				right = Math.max(right, x);
				bottom = Math.max(bottom, y);
			}
		}
	}
	return { x: left, y: top, width: right - left + 1, height: bottom - top + 1 };
}
