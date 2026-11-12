import { z } from 'zod';
import type { TouchMode } from './touch-gestures.ts';

/**
 * The touch input choice (SPEC-DESKTOP-FLOATING FA20, FA21): one set of
 * names, in one order, on the page and in the full-screen sheet, and
 * remembered in this browser so it is the same in and out of full screen
 * and next time. Storage can be blocked: then it is Trackpad, and a change
 * lasts until the page reloads.
 */
const STORAGE_KEY = 'bmuster.desktop.touchInput';

export const TOUCH_MODES: readonly { value: TouchMode; label: string }[] = [
	{ value: 'trackpad', label: 'Trackpad' },
	{ value: 'touch', label: 'Tap to click' },
	{ value: 'fixed', label: 'Fixed cursor' }
];

const touchModeSchema = z.enum(['trackpad', 'touch', 'fixed']);

export function readTouchMode(): TouchMode {
	try {
		const parsed = touchModeSchema.safeParse(localStorage.getItem(STORAGE_KEY));
		return parsed.success ? parsed.data : 'trackpad';
	} catch {
		return 'trackpad';
	}
}

export function saveTouchMode(mode: TouchMode): void {
	try {
		localStorage.setItem(STORAGE_KEY, mode);
	} catch {
		// A per-viewer convenience; the choice lasts until the page reloads.
	}
}

/** One line on what a finger does in each mode. */
export function touchModeHelp(mode: TouchMode): string {
	switch (mode) {
		case 'trackpad':
			return 'Drag to move the pointer, tap to click, double-tap to double-click, double-tap and hold to drag, long press to right-click, two fingers to scroll, pinch to zoom.';
		case 'touch':
			return 'Tap where you want to click, drag to drag, long press to right-click, pinch to zoom.';
		case 'fixed':
			return 'The pointer stays in the middle: drag to move the screen under it, tap to click, double-tap and hold to drag, long press to right-click, two fingers to scroll, pinch to zoom.';
	}
}
