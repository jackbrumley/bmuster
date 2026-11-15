import { z } from 'zod';
import {
	DEFAULT_BAR,
	DEFAULT_POSITION,
	type BarPlace,
	type FloatingPosition
} from './floating-position.ts';

/**
 * What this browser remembers of the floating controls (SPEC-DESKTOP-FLOATING
 * FB7, FB15): whether the bar or the button shows, and where each sits. Full
 * screen and the pop-out keep their own, since they are screens of different
 * sizes. Each machine keeps its own too, since its screen has its menus and
 * title bars in its own places; a machine with nothing saved starts where the
 * controls were last left on this device, for any machine. Storage can be
 * blocked (private windows, site data off); then the controls start at the
 * defaults.
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

/** The device's last-used placement for a view, whichever machine it was. */
function deviceKey(view: ControlsView): string {
	return `bmuster.desktop.controls.${view}`;
}

function machineKey(view: ControlsView, machineId: string): string {
	return `${deviceKey(view)}.${machineId}`;
}

/** What is saved under `key`, or undefined when nothing valid is. */
function saved(key: string): ControlsMemory | undefined {
	const raw = localStorage.getItem(key);
	if (raw === null) {
		return undefined;
	}
	try {
		const parsed = stored.safeParse(JSON.parse(raw));
		return parsed.success ? parsed.data : undefined;
	} catch {
		return undefined;
	}
}

/** The bar at the top centre, shown with a mouse; on touch the button, on the right edge. */
export function defaultControls(touch: boolean): ControlsMemory {
	return { shown: touch ? 'button' : 'bar', bar: DEFAULT_BAR, button: DEFAULT_POSITION };
}

/** This machine's placement, else the device's last-used one, else the defaults. */
export function readControls(
	view: ControlsView,
	machineId: string,
	touch: boolean
): ControlsMemory {
	try {
		return saved(machineKey(view, machineId)) ?? saved(deviceKey(view)) ?? defaultControls(touch);
	} catch {
		return defaultControls(touch);
	}
}

/** Saves the placement for this machine, and as the device's last-used one. */
export function rememberControls(
	view: ControlsView,
	machineId: string,
	memory: ControlsMemory
): void {
	try {
		const json = JSON.stringify(memory);
		localStorage.setItem(machineKey(view, machineId), json);
		localStorage.setItem(deviceKey(view), json);
	} catch {
		// A per-viewer convenience; the controls just start at the defaults next time.
	}
}
