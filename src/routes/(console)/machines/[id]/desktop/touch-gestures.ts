import { BUTTON_LEFT, BUTTON_RIGHT } from '#lib/domain/desktop/messages.ts';
import { contentBox, toDisplay, type Box, type Point, type Size } from './input.ts';
import { clampZoom, NO_ZOOM, pinched, pinchOf, zoomed, zoomedBox, type Zoom } from './zoom.ts';

/**
 * Touch gestures on the remote screen (SPEC-DESKTOP 5.3 and
 * SPEC-DESKTOP-FLOATING option A). Pure apart from the timer it is handed,
 * so the rules are tested without a browser.
 *
 * - Trackpad: one finger moves the pointer by its movement; a tap clicks; a
 *   touch soon after a tap holds the left button and drags.
 * - Touch: a tap moves the pointer there and clicks; a drag holds the button.
 * - Both: a long press right-clicks; a two-finger tap right-clicks; two
 *   fingers scroll at 1x, and pinch or pan the picture's zoom (drawn in the
 *   browser only); a double two-finger tap while zoomed goes back to 1x.
 */

/** Phones: move a pointer like a laptop's trackpad, or tap where to click. */
export type TouchMode = 'trackpad' | 'touch';

/** The unzoomed picture box on the page, the picture's size and the display's. */
export type Geometry = { box: Box; picture: Size; display: Size };

export type TouchSink = {
	pointer(x: number, y: number, buttons: number): void;
	wheel(dx: number, dy: number): void;
	/** The picture's zoom changed: draw it. */
	zoom(zoom: Zoom): void;
};

/** Runs `run` after `ms`; returns the function that cancels it. */
export type Later = (run: () => void, ms: number) => () => void;

/** A finger moved less than this (page pixels) is a tap or a long press. */
const TAP_SLOP = 10;
/** A tap is shorter than this. */
const TAP_MS = 300;
/** A second touch this soon after a tap starts a drag with the button held. */
export const DRAG_AFTER_TAP_MS = 400;
/** A finger held still this long right-clicks. */
const LONG_PRESS_MS = 500;
/** A second two-finger tap this soon after the first, while zoomed, goes back to 1x. */
const DOUBLE_TWO_FINGER_TAP_MS = 400;
/** Two fingers whose distance changes by more than this pinch rather than scroll. */
const PINCH_SLOP = 24;
/** Two fingers whose midpoint moves more than this, without pinching, scroll. */
const SCROLL_SLOP = 10;

export type TwoFingerIntent = 'undecided' | 'scroll' | 'zoom';

/**
 * What two fingers are doing, from where they started to where they are:
 * zoomed in they always pinch and pan; at 1x a change in their distance
 * pinches, and moving together scrolls. Distance is checked first, since a
 * pinch moves the midpoint a little too.
 */
export function twoFingerIntent(
	from: readonly [Point, Point],
	to: readonly [Point, Point],
	isZoomed: boolean
): TwoFingerIntent {
	if (isZoomed) {
		return 'zoom';
	}
	const start = pinchOf(...from);
	const now = pinchOf(...to);
	if (Math.abs(now.distance - start.distance) > PINCH_SLOP) {
		return 'zoom';
	}
	if (Math.hypot(now.mid.x - start.mid.x, now.mid.y - start.mid.y) > SCROLL_SLOP) {
		return 'scroll';
	}
	return 'undecided';
}

/** Display pixels per page pixel: how far a finger's movement moves the remote pointer. */
function displayPerPage(box: Box, picture: Size, display: Size): number {
	const content = contentBox(box, picture);
	return content.width > 0 ? display.width / content.width : 1;
}

function clampTo(value: number, size: number): number {
	return Math.min(Math.max(Math.round(value), 0), size - 1);
}

type Finger = { x: number; y: number; startX: number; startY: number };

type TwoFingers = {
	ids: readonly [number, number];
	from: readonly [Point, Point];
	startZoom: Zoom;
	intent: TwoFingerIntent;
	lastMid: Point;
};

export class TouchGestures {
	mode: TouchMode = 'trackpad';
	/** The remote pointer, in display pixels. */
	position: Point = { x: 0, y: 0 };

	readonly #sink: TouchSink;
	readonly #geometry: () => Geometry | undefined;
	readonly #later: Later;
	readonly #fingers = new Map<number, Finger>();
	#zoom: Zoom = NO_ZOOM;
	#most = 0;
	#moved = false;
	#startedAt = 0;
	#lastTapAt = -Infinity;
	#holding = false;
	#longPress: (() => void) | undefined;
	#longPressed = false;
	#two: TwoFingers | undefined;
	/** A two-finger tap's right click, held back while zoomed in case a second tap resets. */
	#pendingRightClick: (() => void) | undefined;
	#lastTwoFingerTapAt = -Infinity;

	constructor(sink: TouchSink, geometry: () => Geometry | undefined, later: Later) {
		this.#sink = sink;
		this.#geometry = geometry;
		this.#later = later;
	}

	/** The picture's zoom, for mapping a mouse through it too. */
	get zoom(): Zoom {
		return this.#zoom;
	}

	down(id: number, x: number, y: number, at: number): void {
		const geometry = this.#geometry();
		if (geometry === undefined) {
			return;
		}
		if (this.#fingers.size === 0) {
			this.#most = 0;
			this.#moved = false;
			this.#startedAt = at;
			this.#longPressed = false;
			// The screen may have turned or resized since the last gesture.
			this.#setZoom(clampZoom(this.#zoom, geometry.box));
		}
		this.#fingers.set(id, { x, y, startX: x, startY: y });
		this.#most = Math.max(this.#most, this.#fingers.size);
		if (this.#fingers.size === 2) {
			this.#cancelLongPress();
			this.#startTwoFingers();
		}
		if (this.#fingers.size !== 1) {
			return;
		}
		if (this.mode === 'touch') {
			this.position = this.#toDisplay({ x, y }, geometry);
			this.#sink.pointer(this.position.x, this.position.y, 0);
		} else if (at - this.#lastTapAt < DRAG_AFTER_TAP_MS) {
			this.#holding = true;
			this.#sink.pointer(this.position.x, this.position.y, BUTTON_LEFT);
		}
		if (!this.#holding) {
			this.#longPress = this.#later(() => {
				this.#onLongPress();
			}, LONG_PRESS_MS);
		}
	}

	move(id: number, x: number, y: number): void {
		const finger = this.#fingers.get(id);
		const geometry = this.#geometry();
		if (finger === undefined || geometry === undefined) {
			return;
		}
		const dx = x - finger.x;
		const dy = y - finger.y;
		finger.x = x;
		finger.y = y;
		if (Math.hypot(x - finger.startX, y - finger.startY) > TAP_SLOP) {
			this.#moved = true;
			this.#cancelLongPress();
		}
		if (this.#fingers.size >= 2) {
			this.#moveTwoFingers(geometry);
			return;
		}
		// After a long press or a two-finger gesture, the finger left down does nothing.
		if (this.#longPressed || this.#most >= 2) {
			return;
		}
		if (this.mode === 'touch') {
			if (!this.#moved) {
				return;
			}
			const next = this.#toDisplay({ x, y }, geometry);
			if (!this.#holding) {
				this.#holding = true;
				this.#sink.pointer(this.position.x, this.position.y, BUTTON_LEFT);
			}
			this.position = next;
		} else {
			const ratio = displayPerPage(
				zoomedBox(geometry.box, this.#zoom),
				geometry.picture,
				geometry.display
			);
			this.position = {
				x: clampTo(this.position.x + dx * ratio, geometry.display.width),
				y: clampTo(this.position.y + dy * ratio, geometry.display.height)
			};
		}
		this.#sink.pointer(this.position.x, this.position.y, this.#holding ? BUTTON_LEFT : 0);
	}

	up(id: number, at: number): void {
		if (!this.#fingers.delete(id)) {
			return;
		}
		if (this.#fingers.size < 2) {
			this.#two = undefined;
		}
		if (this.#fingers.size > 0) {
			return;
		}
		this.#cancelLongPress();
		const { x, y } = this.position;
		if (this.#holding) {
			this.#holding = false;
			this.#sink.pointer(x, y, 0);
			return;
		}
		if (this.#longPressed || this.#moved || at - this.#startedAt > TAP_MS) {
			return;
		}
		if (this.#most >= 2) {
			this.#twoFingerTap(at);
			return;
		}
		this.#click(BUTTON_LEFT);
		this.#lastTapAt = at;
	}

	/** The browser took the touch away (a system gesture): let go of everything. */
	cancel(): void {
		this.#fingers.clear();
		this.#two = undefined;
		this.#cancelLongPress();
		if (this.#holding) {
			this.#holding = false;
			this.#sink.pointer(this.position.x, this.position.y, 0);
		}
	}

	#toDisplay(page: Point, geometry: Geometry): Point {
		return toDisplay(page, zoomedBox(geometry.box, this.#zoom), geometry.picture, geometry.display);
	}

	#click(button: number): void {
		this.#sink.pointer(this.position.x, this.position.y, button);
		this.#sink.pointer(this.position.x, this.position.y, 0);
	}

	#setZoom(zoom: Zoom): void {
		const before = this.#zoom;
		if (zoom.scale === before.scale && zoom.x === before.x && zoom.y === before.y) {
			return;
		}
		this.#zoom = zoom;
		this.#sink.zoom(zoom);
	}

	#cancelLongPress(): void {
		this.#longPress?.();
		this.#longPress = undefined;
	}

	#onLongPress(): void {
		this.#longPress = undefined;
		if (this.#fingers.size !== 1 || this.#most !== 1 || this.#moved || this.#holding) {
			return;
		}
		this.#longPressed = true;
		this.#click(BUTTON_RIGHT);
	}

	#points(ids: readonly [number, number]): [Point, Point] | undefined {
		const a = this.#fingers.get(ids[0]);
		const b = this.#fingers.get(ids[1]);
		return a === undefined || b === undefined
			? undefined
			: [
					{ x: a.x, y: a.y },
					{ x: b.x, y: b.y }
				];
	}

	#startTwoFingers(): void {
		const [first, second] = [...this.#fingers.keys()];
		if (first === undefined || second === undefined) {
			return;
		}
		const ids = [first, second] as const;
		const from = this.#points(ids);
		if (from === undefined) {
			return;
		}
		this.#two = {
			ids,
			from,
			startZoom: this.#zoom,
			intent: 'undecided',
			lastMid: pinchOf(...from).mid
		};
	}

	#moveTwoFingers(geometry: Geometry): void {
		const two = this.#two;
		const now = two === undefined ? undefined : this.#points(two.ids);
		if (two === undefined || now === undefined) {
			return;
		}
		if (two.intent === 'undecided') {
			two.intent = twoFingerIntent(two.from, now, zoomed(two.startZoom));
		}
		const pinch = pinchOf(...now);
		switch (two.intent) {
			case 'undecided':
				break;
			case 'scroll': {
				const ratio = displayPerPage(geometry.box, geometry.picture, geometry.display);
				const dx = pinch.mid.x - two.lastMid.x;
				const dy = pinch.mid.y - two.lastMid.y;
				if (dx !== 0 || dy !== 0) {
					this.#sink.wheel(-dx * ratio, -dy * ratio);
				}
				break;
			}
			case 'zoom':
				this.#setZoom(pinched(two.startZoom, pinchOf(...two.from), pinch, geometry.box));
				break;
		}
		two.lastMid = pinch.mid;
	}

	#twoFingerTap(at: number): void {
		if (!zoomed(this.#zoom)) {
			this.#click(BUTTON_RIGHT);
			return;
		}
		const pending = this.#pendingRightClick;
		if (pending !== undefined && at - this.#lastTwoFingerTapAt < DOUBLE_TWO_FINGER_TAP_MS) {
			pending();
			this.#pendingRightClick = undefined;
			this.#setZoom(NO_ZOOM);
			return;
		}
		this.#lastTwoFingerTapAt = at;
		this.#pendingRightClick = this.#later(() => {
			this.#pendingRightClick = undefined;
			this.#click(BUTTON_RIGHT);
		}, DOUBLE_TWO_FINGER_TAP_MS);
	}
}
