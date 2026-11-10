import { ALL_DISPLAYS } from './messages.ts';

/**
 * The machine's displays as the console offers them
 * (SPEC-DESKTOP-ALL-SCREENS): the screen picker's choices, with All screens
 * when the agent says it can and there is more than one display, and the
 * size on the machine's desktop that the picture covers, which pointer
 * positions are sent in. Browser-safe.
 */

/** A display's place on the machine's desktop, as the `displays` message lists it. */
export type DisplayPlace = {
	id: string;
	name: string;
	x: number;
	y: number;
	width: number;
	height: number;
};

/** One choice in the screen picker (a `ChipGroup` option). */
export type DisplayChoice = { value: string; label: string; count: undefined };

export const ALL_SCREENS_LABEL = 'All screens';

/** The picker's choices: every display, then All screens when offered. */
export function displayChoices(
	displays: readonly DisplayPlace[],
	allScreens: boolean
): DisplayChoice[] {
	const choices: DisplayChoice[] = displays.map((display) => ({
		value: display.id,
		label: display.name,
		count: undefined
	}));
	if (allScreens && displays.length > 1) {
		choices.push({ value: ALL_DISPLAYS, label: ALL_SCREENS_LABEL, count: undefined });
	}
	return choices;
}

/**
 * The size the picture covers on the machine's desktop: the current
 * display's, or the box around every display for All screens. Undefined
 * while the agent has named nothing it lists.
 */
export function shownSize(
	displays: readonly DisplayPlace[],
	current: string | undefined
): { width: number; height: number } | undefined {
	if (current === ALL_DISPLAYS) {
		if (displays.length === 0) {
			return undefined;
		}
		const left = Math.min(...displays.map((d) => d.x));
		const top = Math.min(...displays.map((d) => d.y));
		const right = Math.max(...displays.map((d) => d.x + d.width));
		const bottom = Math.max(...displays.map((d) => d.y + d.height));
		return { width: right - left, height: bottom - top };
	}
	const display = displays.find((item) => item.id === current);
	return display === undefined ? undefined : { width: display.width, height: display.height };
}
