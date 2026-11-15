import { z } from 'zod';
import {
	DEFAULT_BAR,
	DEFAULT_POSITION,
	type BarPlace,
	type FloatingPosition
} from './floating-position.ts';

/**
 * What this browser remembers of the floating controls (SPEC-DESKTOP-FLOATING
 * FB7): whether the bar or the button shows, and where each sits. Full screen
 * and the pop-out keep their own, since they are screens of different sizes.
 * Storage can be blocked (private windows, site data off); then the controls
 * start at the defaults.
 */

/** Which screen the controls float over: the tab's full screen, or the pop-out window. */
export type ControlsView = 'full-screen' | 'window';

export type ControlsMemory = {
	shown: 'bar' | 'button';
	bar: BarPlace;
	button: FloatingPosition;
};

/** How the bar came to show: as remembered, or expanded from the button at `button` just now. */
export type BarOpening =
	{ kind: 'restored' } | { kind: 'expanded'; button: FloatingPosition; keyboard: boolean };

const fraction = z.number().min(0).max(1);

const stored = z.object({
	shown: z.enum(['bar', 'button']),
	bar: z.object({ x: fraction, y: fraction }),
	button: z.object({ edge: z.enum(['left', 'right', 'top', 'bottom']), at: fraction })
});

function keyOf(view: ControlsView): string {
	return `bmuster.desktop.controls.${view}`;
}

/** The bar at the top centre, shown with a mouse; on touch the button, on the right edge. */
export function defaultControls(touch: boolean): ControlsMemory {
	return { shown: touch ? 'button' : 'bar', bar: DEFAULT_BAR, button: DEFAULT_POSITION };
}

export function readControls(view: ControlsView, touch: boolean): ControlsMemory {
	try {
		const raw = localStorage.getItem(keyOf(view));
		if (raw === null) {
			return defaultControls(touch);
		}
		const parsed = stored.safeParse(JSON.parse(raw));
		return parsed.success ? parsed.data : defaultControls(touch);
	} catch {
		return defaultControls(touch);
	}
}

export function rememberControls(view: ControlsView, memory: ControlsMemory): void {
	try {
		localStorage.setItem(keyOf(view), JSON.stringify(memory));
	} catch {
		// A per-viewer convenience; the controls just start at the defaults next time.
	}
}
