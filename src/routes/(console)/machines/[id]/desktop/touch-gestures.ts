import { BUTTON_LEFT, BUTTON_RIGHT } from '#lib/domain/desktop/messages.ts';
import { centredOn, clampFixed, dragged, underCentre } from './fixed-cursor.ts';
import { contentBox, toDisplay, type Box, type Point, type Size } from './input.ts';
import {
	clampZoom,
	crept,
	edgePanned,
	MAX_ZOOM,
	NO_ZOOM,
	pinched,
	pinchOf,
	pushed,
	sameZoom,
	zoomed,
	zoomedBox,
	type Pinch,
	type Zoom
} from './zoom.ts';

/**
 * Touch gestures on the remote screen (SPEC-DESKTOP 5.3 and
 * SPEC-DESKTOP-FLOATING option A). Pure apart from the timer it is handed,
 * so the rules are tested without a browser.
 *
 * - Trackpad: one finger moves the pointer by its movement, never off the
 *   visible picture; a tap clicks once the double-tap time has passed; tap,
 *   tap is a double click, and tap, then touch and hold (or move) holds the
 *   left button, with no click before it, until the finger lifts (FA16, FA17).
 * - Touch: a tap moves the pointer there and clicks; a drag holds the button;
 *   a second tap next to the first clicks the same pixel.
 * - Fixed cursor: the pointer stays at the centre of the stage and a finger
 *   moves the picture under it; taps as in trackpad (FA22-FA24).
 * - All: a long press right-clicks; a two-finger tap right-clicks; two
 *   fingers scroll at 1x, and pinch or pan the picture's zoom (drawn in the
 *   browser only); a double two-finger tap while zoomed goes back to 1x.
 *   The view never shows past the picture's edges, and an axis where the
 *   picture fits never pans (FA18). Zoomed, the trackpad pointer pushes the
 *   view at the margin and, held still there, creeps it (`edgePan`); in tap
 *   to click a finger near an edge pans it.
 */

/** Phones: a trackpad, tap where to click, or a cursor fixed at the centre. */
export type TouchMode = 'trackpad' | 'touch' | 'fixed';

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
/** Tap to click: a tap this soon after a tap, next to it, clicks the same pixel. */
const DOUBLE_TAP_MS = 400;
/**
 * Trackpad and fixed cursor: a tap's click waits this long after its lift.
 * A touch in that time is a second tap: a double click, or a press and drag.
 */
export const TAP_CLICK_DELAY_MS = 250;
/** A second touch held this long (or moved past the slop) holds the left button. */
export const HOLD_AFTER_TAP_MS = 250;
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

type Finger = { x: number; y: number; startX: number; startY: number };

/** The last tap: when it lifted and where it touched down, on the page. */
type Tap = { at: number; x: number; y: number };

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
	#lastTap: Tap = { at: -Infinity, x: 0, y: 0 };
	#holding = false;
	/** A trackpad tap's click, waiting to see whether a second touch follows: cancels it. */
	#pendingClick: (() => void) | undefined;
	/** A second touch soon after a tap, not yet a tap or a hold: cancels its hold timer. */
	#secondTouch: (() => void) | undefined;
	/** The creep's part-pixel, carried from frame to frame. */
	#creepCarry: Point = { x: 0, y: 0 };
	/** How long the finger has been still, for the creep. */
	#stillMs = 0;
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
			this.#stopCreep();
			// The screen may have turned or resized, or the mode changed, since the last gesture.
			this.#setZoom(
				this.mode === 'fixed'
					? centredOn(
							this.#zoom.scale,
							this.position,
							geometry.box,
							geometry.picture,
							geometry.display
						)
					: this.#zoom
			);
		}
		this.#fingers.set(id, { x, y, startX: x, startY: y });
		this.#most = Math.max(this.#most, this.#fingers.size);
		if (this.#fingers.size === 2) {
			this.#cancelLongPress();
			if (this.#secondTouch !== undefined) {
				// A two-finger gesture after a tap: the tap's click still goes.
				this.#cancelSecondTouch();
				this.#click(BUTTON_LEFT);
			}
			this.#startTwoFingers();
		}
		if (this.#fingers.size !== 1) {
			return;
		}
		const second =
			this.mode !== 'touch' &&
			this.#pendingClick !== undefined &&
			at - this.#lastTap.at < TAP_CLICK_DELAY_MS;
		if (second) {
			// The first tap's click is not sent: this touch decides between a double click and a drag.
			this.#pendingClick?.();
			this.#pendingClick = undefined;
			this.#secondTouch = this.#later(() => {
				this.#secondTouch = undefined;
				this.#startHold();
			}, HOLD_AFTER_TAP_MS);
		} else {
			this.#sendPendingClick();
		}
		if (this.mode === 'touch') {
			const soon = at - this.#lastTap.at < DOUBLE_TAP_MS;
			// A second tap next to the first clicks the same pixel, so the machine sees a double click.
			const near = Math.hypot(x - this.#lastTap.x, y - this.#lastTap.y) <= TAP_SLOP;
			if (!soon || !near) {
				this.position = this.#toDisplay({ x, y }, geometry);
			}
			this.#sink.pointer(this.position.x, this.position.y, 0);
		}
		if (this.#secondTouch === undefined) {
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
		let dx = x - finger.x;
		let dy = y - finger.y;
		finger.x = x;
		finger.y = y;
		if (dx !== 0 || dy !== 0) {
			// Any movement stops the creep and starts its wait again.
			this.#stopCreep();
		}
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
		if (this.#secondTouch !== undefined) {
			// The second touch stays put until it lifts (a double click) or moves past the slop (a drag).
			if (!this.#moved) {
				return;
			}
			this.#cancelSecondTouch();
			this.#startHold();
			dx = x - finger.startX;
			dy = y - finger.startY;
		}
		switch (this.mode) {
			case 'touch': {
				if (!this.#moved) {
					return;
				}
				const next = this.#toDisplay({ x, y }, geometry);
				if (!this.#holding) {
					this.#holding = true;
					this.#sink.pointer(this.position.x, this.position.y, BUTTON_LEFT);
				}
				this.position = next;
				break;
			}
			case 'trackpad': {
				// Never off the visible picture; at the margin it pushes the view.
				const view = pushed(
					this.#zoom,
					geometry.box,
					geometry.picture,
					geometry.display,
					this.position,
					{ x: dx, y: dy }
				);
				this.#setZoom(view.zoom);
				this.position = view.pointer;
				break;
			}
			case 'fixed':
				this.#setZoom(dragged(this.#zoom, dx, dy, geometry.box, geometry.picture));
				this.position = underCentre(this.#zoom, geometry.box, geometry.picture, geometry.display);
				break;
		}
		this.#sink.pointer(this.position.x, this.position.y, this.#holding ? BUTTON_LEFT : 0);
	}

	up(id: number, at: number): void {
		const finger = this.#fingers.get(id);
		if (finger === undefined) {
			return;
		}
		this.#fingers.delete(id);
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
		if (this.#secondTouch !== undefined) {
			// Lifted before the hold time without moving: a double click, back to back at one pixel.
			this.#cancelSecondTouch();
			this.#click(BUTTON_LEFT);
			this.#click(BUTTON_LEFT);
			this.#lastTap = { at: -Infinity, x: 0, y: 0 };
			return;
		}
		if (this.#longPressed || this.#moved || at - this.#startedAt > TAP_MS) {
			return;
		}
		if (this.#most >= 2) {
			this.#twoFingerTap(at);
			return;
		}
		this.#tap(finger, at);
	}

	/**
	 * Edge pan (FA18): called every animation frame while a finger is down.
	 * Zoomed, once the finger has moved: in trackpad mode, a pointer in the
	 * margin with the finger still for `CREEP_DELAY_MS` creeps the view
	 * towards that edge, the pointer keeping its place on the screen and so
	 * travelling with the view on the machine; in tap to click a finger in
	 * the band at an edge pans the picture `elapsedMs` worth and the pointer
	 * follows what is now under it. True while a finger is down that may
	 * still pan, so the caller asks for another frame.
	 */
	edgePan(elapsedMs: number): boolean {
		const geometry = this.#geometry();
		const [finger] = this.#fingers.values();
		if (
			geometry === undefined ||
			finger === undefined ||
			this.mode === 'fixed' ||
			this.#fingers.size !== 1 ||
			this.#most !== 1 ||
			this.#longPressed ||
			!zoomed(this.#zoom)
		) {
			return false;
		}
		// The hard limit every frame: the screen may have turned or resized under the finger.
		this.#setZoom(this.#zoom);
		// A tap, a long press or a second touch still deciding never pans.
		if (!this.#moved || this.#secondTouch !== undefined) {
			return true;
		}
		const buttons = this.#holding ? BUTTON_LEFT : 0;
		if (this.mode === 'touch') {
			const pointer = { x: finger.x, y: finger.y };
			const next = edgePanned(this.#zoom, geometry.box, geometry.picture, pointer, elapsedMs);
			if (!sameZoom(next, this.#zoom)) {
				this.#setZoom(next);
				this.position = this.#toDisplay(pointer, geometry);
				this.#sink.pointer(this.position.x, this.position.y, buttons);
			}
			return true;
		}
		this.#stillMs += elapsedMs;
		const step = crept(
			this.#zoom,
			geometry.box,
			geometry.picture,
			geometry.display,
			this.position,
			this.#stillMs,
			elapsedMs,
			this.#creepCarry
		);
		this.#creepCarry = step.carry;
		this.#setZoom(step.zoom);
		if (step.pointer.x !== this.position.x || step.pointer.y !== this.position.y) {
			this.position = step.pointer;
			this.#sink.pointer(this.position.x, this.position.y, buttons);
		}
		return true;
	}

	/** The browser took the touch away (a system gesture): let go of everything. */
	cancel(): void {
		this.#fingers.clear();
		this.#two = undefined;
		this.#cancelLongPress();
		this.#cancelSecondTouch();
		this.#pendingClick?.();
		this.#pendingClick = undefined;
		if (this.#holding) {
			this.#holding = false;
			this.#sink.pointer(this.position.x, this.position.y, 0);
		}
	}

	#toDisplay(page: Point, geometry: Geometry): Point {
		return toDisplay(page, zoomedBox(geometry.box, this.#zoom), geometry.picture, geometry.display);
	}

	/** Tap to click clicks at once; the others wait to see whether a second touch follows. */
	#tap(finger: Finger, at: number): void {
		this.#lastTap = { at, x: finger.startX, y: finger.startY };
		if (this.mode === 'touch') {
			this.#click(BUTTON_LEFT);
			return;
		}
		this.#pendingClick = this.#later(() => {
			this.#pendingClick = undefined;
			this.#click(BUTTON_LEFT);
		}, TAP_CLICK_DELAY_MS);
	}

	/** A waiting tap's click goes now: its timer was late, or the next touch is not a second tap. */
	#sendPendingClick(): void {
		if (this.#pendingClick === undefined) {
			return;
		}
		this.#pendingClick();
		this.#pendingClick = undefined;
		this.#click(BUTTON_LEFT);
	}

	/** Presses the left button where the pointer is, for a drag after a tap. */
	#startHold(): void {
		if (this.#fingers.size !== 1 || this.#most !== 1 || this.#holding) {
			return;
		}
		this.#holding = true;
		this.#sink.pointer(this.position.x, this.position.y, BUTTON_LEFT);
	}

	#cancelSecondTouch(): void {
		this.#secondTouch?.();
		this.#secondTouch = undefined;
	}

	#click(button: number): void {
		this.#sink.pointer(this.position.x, this.position.y, button);
		this.#sink.pointer(this.position.x, this.position.y, 0);
	}

	#stopCreep(): void {
		this.#stillMs = 0;
		this.#creepCarry = { x: 0, y: 0 };
	}

	/**
	 * Every change of view goes through here, inside the mode's hard limit:
	 * the fixed cursor's (half the box past the picture's edge) or the
	 * others' (never past it, centred where it fits).
	 */
	#setZoom(zoom: Zoom): void {
		const geometry = this.#geometry();
		const next =
			geometry === undefined
				? zoom
				: this.mode === 'fixed'
					? clampFixed(zoom, geometry.box, geometry.picture)
					: clampZoom(zoom, geometry.box, geometry.picture);
		if (sameZoom(next, this.#zoom)) {
			return;
		}
		this.#zoom = next;
		this.#sink.zoom(next);
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
			// The fixed cursor pans with one finger, so two fingers scroll there at any zoom.
			two.intent = twoFingerIntent(two.from, now, this.mode !== 'fixed' && zoomed(two.startZoom));
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
				this.#setZoom(this.#pinchedZoom(two, pinch, geometry));
				break;
		}
		two.lastMid = pinch.mid;
	}

	/** A pinch: about its midpoint, or about the centre for the fixed cursor (which stays put). */
	#pinchedZoom(two: TwoFingers, pinch: Pinch, geometry: Geometry): Zoom {
		const from = pinchOf(...two.from);
		if (this.mode !== 'fixed') {
			return pinched(two.startZoom, from, pinch, geometry.box, geometry.picture);
		}
		const ratio = from.distance > 0 ? pinch.distance / from.distance : 1;
		const scale = Math.min(Math.max(two.startZoom.scale * ratio, 1), MAX_ZOOM);
		return centredOn(scale, this.position, geometry.box, geometry.picture, geometry.display);
	}

	/** Back to 1x; the fixed cursor keeps its pixel under the centre. */
	#unzoomed(): Zoom {
		const geometry = this.#geometry();
		return this.mode === 'fixed' && geometry !== undefined
			? centredOn(1, this.position, geometry.box, geometry.picture, geometry.display)
			: NO_ZOOM;
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
			this.#setZoom(this.#unzoomed());
			return;
		}
		this.#lastTwoFingerTapAt = at;
		this.#pendingRightClick = this.#later(() => {
			this.#pendingRightClick = undefined;
			this.#click(BUTTON_RIGHT);
		}, DOUBLE_TWO_FINGER_TAP_MS);
	}
}
