import type { Terminal } from '@xterm/xterm';
import {
	flingSpeed,
	momentumStep,
	moveDrag,
	rowsFromPixels,
	startDrag,
	type Drag
} from './touch-scroll.ts';

/**
 * Swiping the terminal on a phone scrolls its history, not the page
 * (xterm.js 6 has no touch scrolling of its own). In the alternate screen
 * (vim, less, htop) there is no history: each row of the swipe becomes the
 * wheel event xterm.js would get from a mouse, so it sends the program arrow
 * keys or, when the program asked for the mouse, wheel reports. A tap is left
 * alone, so it still focuses the terminal and opens the keyboard.
 */
export function attachTouchScroll(host: HTMLElement, terminal: Terminal): () => void {
	let drag: Drag | undefined;
	let frame: number | undefined;
	let point = { x: 0, y: 0 };

	function cellHeight(): number {
		const screen = host.querySelector('.xterm-screen');
		return screen === null || terminal.rows === 0 ? 0 : screen.clientHeight / terminal.rows;
	}

	/** The program draws its own screen, or listens to the mouse: let it scroll. */
	function programScrolls(): boolean {
		return (
			terminal.buffer.active.type === 'alternate' || terminal.modes.mouseTrackingMode !== 'none'
		);
	}

	function scroll(rows: number): void {
		if (rows === 0) {
			return;
		}
		const element = terminal.element;
		if (!programScrolls() || element === undefined) {
			terminal.scrollLines(rows);
			return;
		}
		for (let index = 0; index < Math.abs(rows); index++) {
			element.dispatchEvent(
				new WheelEvent('wheel', {
					deltaY: Math.sign(rows),
					deltaMode: WheelEvent.DOM_DELTA_LINE,
					clientX: point.x,
					clientY: point.y,
					bubbles: true,
					cancelable: true
				})
			);
		}
	}

	function stopMomentum(): void {
		if (frame !== undefined) {
			cancelAnimationFrame(frame);
			frame = undefined;
		}
	}

	/** A flick keeps the history moving and slows down; never in the alternate screen, where it would type. */
	function fling(speed: number): void {
		let velocity = speed;
		let remainderPx = 0;
		let last = performance.now();
		const height = cellHeight();
		const tick = (now: number): void => {
			const step = momentumStep(velocity, now - last);
			last = now;
			const rows = rowsFromPixels(remainderPx, step.distancePx, height);
			remainderPx = rows.remainderPx;
			terminal.scrollLines(rows.rows);
			velocity = step.velocity;
			frame = step.done ? undefined : requestAnimationFrame(tick);
		};
		frame = requestAnimationFrame(tick);
	}

	function onStart(event: TouchEvent): void {
		stopMomentum();
		const touch = event.touches[0];
		drag =
			event.touches.length === 1 && touch !== undefined
				? startDrag(touch.clientX, touch.clientY, event.timeStamp)
				: undefined;
	}

	function onMove(event: TouchEvent): void {
		const touch = event.touches[0];
		if (drag === undefined || touch === undefined) {
			return;
		}
		point = { x: touch.clientX, y: touch.clientY };
		const move = moveDrag(drag, touch.clientX, touch.clientY, event.timeStamp, cellHeight());
		drag = move.drag;
		if (move.captured) {
			event.preventDefault();
			scroll(move.rows);
		}
	}

	function onCancel(): void {
		drag = undefined;
	}

	function onEnd(event: TouchEvent): void {
		if (drag !== undefined && !programScrolls()) {
			const speed = flingSpeed(drag, event.timeStamp);
			if (speed !== 0) {
				fling(speed);
			}
		}
		drag = undefined;
	}

	host.addEventListener('touchstart', onStart, { passive: true });
	host.addEventListener('touchmove', onMove, { passive: false });
	host.addEventListener('touchend', onEnd, { passive: true });
	host.addEventListener('touchcancel', onCancel, { passive: true });
	return () => {
		stopMomentum();
		host.removeEventListener('touchstart', onStart);
		host.removeEventListener('touchmove', onMove);
		host.removeEventListener('touchend', onEnd);
		host.removeEventListener('touchcancel', onCancel);
	};
}
