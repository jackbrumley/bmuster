import type { InputMessage } from '#lib/domain/desktop/messages.ts';
import { KeyFilter, toDisplay, TouchGestures, type Geometry, type TouchMode } from './input.ts';

/**
 * Joins the viewer's mouse, keyboard and fingers on the screen element to
 * the session (SPEC-DESKTOP 5.3, R7): mouse moves once per animation frame
 * and button changes at once, keys by position through the AltGr filter,
 * touch through the trackpad or touch gestures, and release-all whenever
 * the page loses focus or is hidden.
 *
 * The listeners are attached here, not in the template, because the wheel
 * and touch ones must cancel the page's own scrolling (not passive), and
 * the screen takes the keyboard like any remote desktop window.
 */

export type ScreenInputHost = {
	send(message: InputMessage): void;
	/** False for a watch-only session or before the machine's end is open. */
	controlling(): boolean;
	geometry(): Geometry | undefined;
	touchMode(): TouchMode;
};

/** Attaches the input; returns the function that takes it off again. */
export function attachScreenInput(surface: HTMLElement, host: ScreenInputHost): () => void {
	const send = (message: InputMessage) => {
		if (host.controlling()) {
			host.send(message);
		}
	};
	const keys = new KeyFilter(send, (run, ms) => {
		const timer = setTimeout(run, ms);
		return () => {
			clearTimeout(timer);
		};
	});
	const gestures = new TouchGestures(
		{
			pointer: (x, y, buttons) => {
				send({ type: 'pointer', x, y, buttons });
			},
			wheel: (dx, dy) => {
				send({ type: 'wheel', dx, dy, mode: 'pixel' });
			}
		},
		() => host.geometry()
	);
	let pendingMove: { x: number; y: number; buttons: number } | undefined;
	let moveScheduled = false;

	const mouseAt = (event: PointerEvent) => {
		const shape = host.geometry();
		return shape === undefined
			? undefined
			: toDisplay({ x: event.clientX, y: event.clientY }, shape.box, shape.picture, shape.display);
	};
	const button = (event: PointerEvent) => {
		const at = mouseAt(event);
		if (at !== undefined) {
			pendingMove = undefined;
			send({ type: 'pointer', ...at, buttons: event.buttons });
		}
	};
	const releaseAll = () => {
		keys.reset();
		gestures.cancel();
		send({ type: 'release-all' });
	};
	const onVisibility = () => {
		if (document.visibilityState === 'hidden') {
			releaseAll();
		}
	};

	const detachers: (() => void)[] = [];
	const on = <K extends keyof HTMLElementEventMap>(
		name: K,
		listener: (event: HTMLElementEventMap[K]) => void
	) => {
		surface.addEventListener(name, listener, { passive: false });
		detachers.push(() => {
			surface.removeEventListener(name, listener);
		});
	};
	on('pointerdown', (event) => {
		if (event.pointerType === 'touch') {
			gestures.mode = host.touchMode();
			gestures.down(event.pointerId, event.clientX, event.clientY, event.timeStamp);
			return;
		}
		surface.focus();
		surface.setPointerCapture(event.pointerId);
		button(event);
	});
	on('pointermove', (event) => {
		if (event.pointerType === 'touch') {
			gestures.move(event.pointerId, event.clientX, event.clientY);
			return;
		}
		const at = mouseAt(event);
		if (at === undefined || !host.controlling()) {
			return;
		}
		pendingMove = { ...at, buttons: event.buttons };
		if (!moveScheduled) {
			moveScheduled = true;
			requestAnimationFrame(() => {
				moveScheduled = false;
				if (pendingMove !== undefined) {
					send({ type: 'pointer', ...pendingMove });
					pendingMove = undefined;
				}
			});
		}
	});
	on('pointerup', (event) => {
		if (event.pointerType === 'touch') {
			gestures.up(event.pointerId, event.timeStamp);
			return;
		}
		button(event);
	});
	on('pointercancel', () => {
		gestures.cancel();
	});
	on('contextmenu', (event) => {
		event.preventDefault();
	});
	on('wheel', (event) => {
		if (!host.controlling()) {
			return;
		}
		event.preventDefault();
		const mode = event.deltaMode === WheelEvent.DOM_DELTA_PIXEL ? 'pixel' : 'line';
		send({ type: 'wheel', dx: event.deltaX, dy: event.deltaY, mode });
	});
	const key = (event: KeyboardEvent, down: boolean) => {
		if (!host.controlling()) {
			return;
		}
		event.preventDefault();
		if (down) {
			keys.down(event.code, event.key);
		} else {
			keys.up(event.code, event.key);
		}
	};
	on('keydown', (event) => {
		key(event, true);
	});
	on('keyup', (event) => {
		key(event, false);
	});
	surface.tabIndex = 0;
	window.addEventListener('blur', releaseAll);
	document.addEventListener('visibilitychange', onVisibility);
	return () => {
		for (const detach of detachers) {
			detach();
		}
		window.removeEventListener('blur', releaseAll);
		document.removeEventListener('visibilitychange', onVisibility);
		keys.reset();
	};
}
