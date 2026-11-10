import { describe, expect, it } from 'vitest';
import { ALL_SCREENS_LABEL, displayChoices, shownSize, type DisplayPlace } from './displays.ts';

// SPEC-DESKTOP-ALL-SCREENS A8, A10.

const PANEL: DisplayPlace = {
	id: 'eDP-1',
	name: 'eDP-1',
	x: 320,
	y: 1440,
	width: 1920,
	height: 1200
};
const ABOVE: DisplayPlace = { id: 'DP-2', name: 'DP-2', x: 0, y: 0, width: 2560, height: 1440 };

describe('the screen picker', () => {
	it('A8: offers All screens only with two or more displays and an agent that can', () => {
		expect(displayChoices([PANEL, ABOVE], true).map((c) => c.label)).toEqual([
			'eDP-1',
			'DP-2',
			ALL_SCREENS_LABEL
		]);
		expect(displayChoices([PANEL, ABOVE], true).at(-1)?.value).toBe('all');
		// An older agent says nothing, which reads as false.
		expect(displayChoices([PANEL, ABOVE], false).map((c) => c.value)).toEqual(['eDP-1', 'DP-2']);
		expect(displayChoices([PANEL], true).map((c) => c.value)).toEqual(['eDP-1']);
		expect(displayChoices([], true)).toEqual([]);
	});
});

describe('the size the picture covers', () => {
	it('A10: is the current display, or the box around them all', () => {
		expect(shownSize([PANEL, ABOVE], 'eDP-1')).toEqual({ width: 1920, height: 1200 });
		// One above the other, offset: 2560 wide (the upper one), 2640 high.
		expect(shownSize([PANEL, ABOVE], 'all')).toEqual({ width: 2560, height: 2640 });
		// Negative places: the box starts at the top-left corner.
		expect(
			shownSize(
				[
					{ ...ABOVE, x: -2560, y: -100 },
					{ ...PANEL, x: 0, y: 0 }
				],
				'all'
			)
		).toEqual({ width: 4480, height: 1440 });
		expect(shownSize([PANEL], 'gone')).toBeUndefined();
		expect(shownSize([], 'all')).toBeUndefined();
		expect(shownSize([PANEL], undefined)).toBeUndefined();
	});
});
