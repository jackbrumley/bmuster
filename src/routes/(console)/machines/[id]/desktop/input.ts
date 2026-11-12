import type { InputMessage } from '#lib/domain/desktop/messages.ts';

/**
 * Turning the viewer's mouse, keyboard and fingers into the desktop's input
 * messages (SPEC-DESKTOP 5.3, R7). Pure, so the rules are tested without a
 * machine: coordinates through scale and letterboxing, and AltGr. Touch
 * gestures are in touch-gestures.ts.
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

/** A display pixel back to where it shows on the page: the reverse of `toDisplay`. */
export function toPage(point: Point, box: Box, picture: Size, display: Size): Point {
	const content = contentBox(box, picture);
	return {
		x: content.left + (point.x / display.width) * content.width,
		y: content.top + (point.y / display.height) * content.height
	};
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
