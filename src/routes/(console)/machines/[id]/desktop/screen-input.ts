import type { InputMessage } from '#lib/domain/desktop/messages.ts';
import type { InputKind } from './cursor-plan.ts';
import { KeyFilter, toDisplay } from './input.ts';
import type { CursorFeed } from './local-cursor.ts';
import { TouchGestures, type Geometry, type Later, type TouchMode } from './touch-gestures.ts';
import { zoomedBox, type Zoom } from './zoom.ts';

/**
 * Joins the viewer's mouse, keyboard and fingers on the screen element to
 * the session (SPEC-DESKTOP 5.3, R7): mouse moves once per animation frame
 * and button changes at once, keys by position through the AltGr filter,
 * touch through the trackpad or touch gestures, and release-all whenever
 * the page loses focus or is hidden.
 *
 * The listeners are attached here, not in the template, because the wheel
 * and touch ones must cancel the page's own scrolling (not passive), and
 * the screen takes the keyboard like any remote desktop window. A pinch
 * zooms the picture in the browser (`zoom`), and the mouse maps through
 * that zoom too. Events
 * whose target is a control laid over the screen never reach the machine.
 */

export type ScreenInputHost = {
	send(message: InputMessage): void;
	/** False for a watch-only session or before the machine's end is open. */
	controlling(): boolean;
	/** The unzoomed picture box, the picture's size and the display's. */
	geometry(): Geometry | undefined;
	touchMode(): TouchMode;
	/** Draws the picture at this zoom. */
	zoom(zoom: Zoom): void;
	/** The local cursor (SPEC-DESKTOP 20): told where each pointer message went. */
	cursor: CursorFeed;
};

/** Attaches the input; returns the function that takes it off again. */
export function attachScreenInput(surface: HTMLElement, host: ScreenInputHost): () => void {
	const send = (message: InputMessage) => {
		if (host.controlling()) {
			host.send(message);
		}
	};
	const pointer = (x: number, y: number, buttons: number, kind: InputKind) => {
		if (host.controlling()) {
			host.send({ type: 'pointer', x, y, buttons });
			host.cursor.sent(x, y, kind);
		}
	};
	const later: Later = (run, ms) => {
		const timer = setTimeout(run, ms);
		return () => {
			clearTimeout(timer);
		};
	};
	const keys = new KeyFilter(send, later);
	const gestures = new TouchGestures(
		{
			pointer: (x, y, buttons) => {
				pointer(x, y, buttons, 'touch');
			},
			wheel: (dx, dy) => {
				send({ type: 'wheel', dx, dy, mode: 'pixel' });
			},
			zoom: (zoom) => {
				host.zoom(zoom);
			}
		},
		() => host.geometry(),
		later
	);
	let pendingMove: { x: number; y: number; buttons: number } | undefined;
	let moveScheduled = false;

	const mouseAt = (event: PointerEvent) => {
		const shape = host.geometry();
		return shape === undefined
			? undefined
			: toDisplay(
					{ x: event.clientX, y: event.clientY },
					zoomedBox(shape.box, gestures.zoom),
					shape.picture,
					shape.display
				);
	};
	const button = (event: PointerEvent) => {
		const at = mouseAt(event);
		if (at !== undefined) {
			pendingMove = undefined;
			pointer(at.x, at.y, event.buttons, 'mouse');
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
		const onScreen = (event: HTMLElementEventMap[K]) => {
			// Controls drawn over the screen (the full-screen bar) keep their own
			// clicks and keys; only the screen itself feeds the machine.
			if (event.target === surface) {
				listener(event);
			}
		};
		surface.addEventListener(name, onScreen, { passive: false });
		detachers.push(() => {
			surface.removeEventListener(name, onScreen);
		});
	};
	on('pointerdown', (event) => {
		if (event.pointerType === 'touch') {
			gestures.mode = host.touchMode();
			// The trackpad carries on from where the cursor is shown.
			const shown = host.cursor.adoptable();
			if (shown !== undefined) {
				gestures.position = shown;
			}
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
					pointer(pendingMove.x, pendingMove.y, pendingMove.buttons, 'mouse');
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
		gestures.cancel();
	};
}
