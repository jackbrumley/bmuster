/**
 * One press on a movable control: the floating button, or the bar's
 * handle (SPEC-DESKTOP-FLOATING). A press that moves more than a few
 * pixels drags; one that moves less is a tap, which the control's click
 * handles. While pressed, the pointer belongs to the control wherever it
 * goes: its moves and release are taken on the window in the capture
 * phase and stopped there, so a drag across the screen never reaches the
 * machine (the screen's input only takes events aimed at itself, too).
 */

/** A press that moves less than this (page pixels) is a tap, not a drag. */
const DRAG_THRESHOLD_PX = 8;

/** A point in the page, in client pixels. */
export type Point = { x: number; y: number };

type Press = {
	id: number;
	start: Point;
	/** Where in the control the pointer went down. */
	offset: Point;
	moved: boolean;
};

export class PressDrag {
	#press: Press | undefined;
	/** The click that follows a drag's release is not a tap. */
	#afterDrag = false;
	readonly #started: () => void;
	readonly #moved: (corner: Point) => void;
	readonly #dropped: (corner: Point) => void;

	/** Each callback gets the control's top-left corner, in client pixels. */
	constructor(on: {
		started: () => void;
		moved: (corner: Point) => void;
		dropped: (corner: Point) => void;
	}) {
		this.#started = on.started;
		this.#moved = on.moved;
		this.#dropped = on.dropped;
	}

	/** The pointer went down on `handle`; `control` is what moves. */
	down(event: PointerEvent, control: HTMLElement): void {
		this.#afterDrag = false;
		if (event.pointerType === 'mouse' && event.button !== 0) {
			return;
		}
		const box = control.getBoundingClientRect();
		this.#press = {
			id: event.pointerId,
			start: { x: event.clientX, y: event.clientY },
			offset: { x: event.clientX - box.left, y: event.clientY - box.top },
			moved: false
		};
		window.addEventListener('pointermove', this.#onMove, { capture: true });
		window.addEventListener('pointerup', this.#onUp, { capture: true });
		window.addEventListener('pointercancel', this.#onCancel, { capture: true });
	}

	/** Whether a click is a tap: false once, for the click that ends a drag. */
	tapped(): boolean {
		if (this.#afterDrag) {
			this.#afterDrag = false;
			return false;
		}
		return true;
	}

	release(): void {
		this.#press = undefined;
		window.removeEventListener('pointermove', this.#onMove, { capture: true });
		window.removeEventListener('pointerup', this.#onUp, { capture: true });
		window.removeEventListener('pointercancel', this.#onCancel, { capture: true });
	}

	#held(event: PointerEvent): Press | undefined {
		return this.#press?.id === event.pointerId ? this.#press : undefined;
	}

	#corner(event: PointerEvent, held: Press): Point {
		return { x: event.clientX - held.offset.x, y: event.clientY - held.offset.y };
	}

	readonly #onMove = (event: PointerEvent): void => {
		const held = this.#held(event);
		if (held === undefined) {
			return;
		}
		event.stopPropagation();
		if (
			!held.moved &&
			Math.hypot(event.clientX - held.start.x, event.clientY - held.start.y) <= DRAG_THRESHOLD_PX
		) {
			return;
		}
		if (!held.moved) {
			held.moved = true;
			this.#started();
		}
		this.#moved(this.#corner(event, held));
	};

	readonly #onUp = (event: PointerEvent): void => {
		const held = this.#held(event);
		if (held === undefined) {
			return;
		}
		event.stopPropagation();
		if (held.moved) {
			this.#afterDrag = true;
			this.#dropped(this.#corner(event, held));
		}
		this.release();
	};

	readonly #onCancel = (event: PointerEvent): void => {
		if (this.#held(event) !== undefined) {
			this.release();
		}
	};
}
