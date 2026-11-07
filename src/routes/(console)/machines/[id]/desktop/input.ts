import { BUTTON_LEFT, BUTTON_RIGHT, type InputMessage } from '#lib/domain/desktop/messages.ts';

/**
 * Turning the viewer's mouse, keyboard and fingers into the desktop's input
 * messages (SPEC-DESKTOP 5.3, R7). Pure, so the rules are tested without a
 * machine: coordinates through scale and letterboxing, AltGr, and the
 * trackpad and touch gestures.
 */

export type Box = { left: number; top: number; width: number; height: number };
export type Size = { width: number; height: number };
export type Point = { x: number; y: number };

/** Where the picture sits inside `box` when shown whole and centred (object-fit: contain). */
export function contentBox(box: Box, picture: Size): Box {
	if (picture.width <= 0 || picture.height <= 0 || box.width <= 0 || box.height <= 0) {
		return box;
	}
	const scale = Math.min(box.width / picture.width, box.height / picture.height);
	const width = picture.width * scale;
	const height = picture.height * scale;
	return {
		left: box.left + (box.width - width) / 2,
		top: box.top + (box.height - height) / 2,
		width,
		height
	};
}

/**
 * A point on the page to the display's own pixels, whatever the stream's
 * scale (5.3: changing scale never moves a click). Points on the bars
 * beside the picture clamp to its edge.
 */
export function toDisplay(page: Point, box: Box, picture: Size, display: Size): Point {
	const content = contentBox(box, picture);
	const fx = (page.x - content.left) / content.width;
	const fy = (page.y - content.top) / content.height;
	const clamp = (value: number, size: number) =>
		Math.min(Math.max(Math.round(value * size), 0), size - 1);
	return { x: clamp(fx, display.width), y: clamp(fy, display.height) };
}

/** Display pixels per page pixel: how far a finger's movement moves the remote pointer. */
function displayPerPage(box: Box, picture: Size, display: Size): number {
	const content = contentBox(box, picture);
	return content.width > 0 ? display.width / content.width : 1;
}

type KeyMessage = Extract<InputMessage, { type: 'key' }>;

/** How long a left Ctrl waits to see whether it is the start of AltGr. */
const ALTGR_WAIT_MS = 10;

/**
 * Keys by position, with AltGr (5.3). Windows browsers report AltGr as a
 * made-up ControlLeft immediately followed by AltRight: ControlLeft is held
 * back for up to 10 ms, and when AltRight follows it is dropped and AltRight
 * goes with `altGr: true`. A real Ctrl, then Alt later, stays as it is.
 */
export class KeyFilter {
	readonly #send: (message: KeyMessage) => void;
	readonly #later: (run: () => void, ms: number) => () => void;
	#heldCtrl: { key: string; cancel: () => void } | undefined;
	#ctrlSwallowed = false;
	#altGrDown = false;

	constructor(
		send: (message: KeyMessage) => void,
		later: (run: () => void, ms: number) => () => void
	) {
		this.#send = send;
		this.#later = later;
	}

	down(code: string, key: string): void {
		if (code === 'ControlLeft') {
			this.#flushCtrl();
			const cancel = this.#later(() => {
				this.#flushCtrl();
			}, ALTGR_WAIT_MS);
			this.#heldCtrl = { key, cancel };
			return;
		}
		if (code === 'AltRight') {
			const synthetic = this.#heldCtrl !== undefined;
			if (synthetic) {
				this.#heldCtrl?.cancel();
				this.#heldCtrl = undefined;
				this.#ctrlSwallowed = true;
			}
			this.#altGrDown = synthetic || key === 'AltGraph';
			this.#send({ type: 'key', code, key, down: true, altGr: this.#altGrDown });
			return;
		}
		this.#flushCtrl();
		this.#send({ type: 'key', code, key, down: true, altGr: false });
	}

	up(code: string, key: string): void {
		if (code === 'ControlLeft' && this.#ctrlSwallowed) {
			this.#ctrlSwallowed = false;
			return;
		}
		this.#flushCtrl();
		const altGr = code === 'AltRight' && this.#altGrDown;
		if (code === 'AltRight') {
			this.#altGrDown = false;
		}
		this.#send({ type: 'key', code, key, down: false, altGr });
	}

	/** Forgets held keys (release-all clears the machine's side). */
	reset(): void {
		this.#heldCtrl?.cancel();
		this.#heldCtrl = undefined;
		this.#ctrlSwallowed = false;
		this.#altGrDown = false;
	}

	#flushCtrl(): void {
		const held = this.#heldCtrl;
		if (held === undefined) {
			return;
		}
		held.cancel();
		this.#heldCtrl = undefined;
		this.#send({ type: 'key', code: 'ControlLeft', key: held.key, down: true, altGr: false });
	}
}

/** Phones: move a pointer like a laptop's trackpad, or tap where to click. */
export type TouchMode = 'trackpad' | 'touch';

export type Geometry = { box: Box; picture: Size; display: Size };

export type TouchSink = {
	pointer(x: number, y: number, buttons: number): void;
	wheel(dx: number, dy: number): void;
};

/** A finger moved less than this (page pixels) is a tap. */
const TAP_SLOP = 10;
/** A tap is shorter than this. */
const TAP_MS = 300;
/** A second touch this soon after a tap starts a drag with the button held. */
const DRAG_AFTER_TAP_MS = 350;

type Finger = { x: number; y: number; startX: number; startY: number };

/**
 * Touch gestures (5.3). Trackpad: one finger moves the pointer relatively;
 * tap clicks left; two-finger tap clicks right; two fingers scroll; tap then
 * touch-and-drag holds the left button. Touch: a tap moves the pointer there
 * and clicks; a drag holds the button. Both send absolute positions.
 */
export class TouchGestures {
	mode: TouchMode = 'trackpad';
	/** The remote pointer, in display pixels. */
	position: Point = { x: 0, y: 0 };

	readonly #sink: TouchSink;
	readonly #geometry: () => Geometry | undefined;
	readonly #fingers = new Map<number, Finger>();
	#most = 0;
	#moved = false;
	#startedAt = 0;
	#lastTapAt = -Infinity;
	#holding = false;

	constructor(sink: TouchSink, geometry: () => Geometry | undefined) {
		this.#sink = sink;
		this.#geometry = geometry;
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
		}
		this.#fingers.set(id, { x, y, startX: x, startY: y });
		this.#most = Math.max(this.#most, this.#fingers.size);
		if (this.#fingers.size !== 1) {
			return;
		}
		if (this.mode === 'touch') {
			this.position = toDisplay({ x, y }, geometry.box, geometry.picture, geometry.display);
			this.#sink.pointer(this.position.x, this.position.y, 0);
		} else if (at - this.#lastTapAt < DRAG_AFTER_TAP_MS) {
			this.#holding = true;
			this.#sink.pointer(this.position.x, this.position.y, BUTTON_LEFT);
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
		}
		const ratio = displayPerPage(geometry.box, geometry.picture, geometry.display);
		if (this.#fingers.size >= 2) {
			// Each finger reports its own move; half each is the pair's.
			this.#sink.wheel((-dx * ratio) / 2, (-dy * ratio) / 2);
			return;
		}
		if (this.mode === 'touch') {
			if (!this.#moved) {
				return;
			}
			const next = toDisplay({ x, y }, geometry.box, geometry.picture, geometry.display);
			if (!this.#holding) {
				this.#holding = true;
				this.#sink.pointer(this.position.x, this.position.y, BUTTON_LEFT);
			}
			this.position = next;
		} else {
			this.position = {
				x: clampTo(this.position.x + dx * ratio, geometry.display.width),
				y: clampTo(this.position.y + dy * ratio, geometry.display.height)
			};
		}
		this.#sink.pointer(this.position.x, this.position.y, this.#holding ? BUTTON_LEFT : 0);
	}

	up(id: number, at: number): void {
		if (!this.#fingers.delete(id) || this.#fingers.size > 0) {
			return;
		}
		const { x, y } = this.position;
		if (this.#holding) {
			this.#holding = false;
			this.#sink.pointer(x, y, 0);
			return;
		}
		if (this.#moved || at - this.#startedAt > TAP_MS) {
			return;
		}
		const button = this.#most >= 2 ? BUTTON_RIGHT : BUTTON_LEFT;
		this.#sink.pointer(x, y, button);
		this.#sink.pointer(x, y, 0);
		this.#lastTapAt = button === BUTTON_LEFT ? at : -Infinity;
	}

	/** The browser took the touch away (a system gesture): let go of everything. */
	cancel(): void {
		this.#fingers.clear();
		if (this.#holding) {
			this.#holding = false;
			this.#sink.pointer(this.position.x, this.position.y, 0);
		}
	}
}

function clampTo(value: number, size: number): number {
	return Math.min(Math.max(Math.round(value), 0), size - 1);
}
