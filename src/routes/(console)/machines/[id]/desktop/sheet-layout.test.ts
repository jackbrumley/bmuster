import { describe, expect, it } from 'vitest';
import { CHROME_ACTIONS } from './session-actions.ts';
import { scrollEdges, sheetLayout, sheetTabs } from './sheet-layout.ts';

// SPEC-DESKTOP-FLOATING FA3, FA7.

const upright = { width: 351, height: 643 };
const onItsSide = { width: 643, height: 351 };

describe('the sheet', () => {
	it('FA3: is a bottom sheet on an upright screen, wherever the button is', () => {
		for (const edge of ['left', 'right', 'top', 'bottom'] as const) {
			expect(sheetLayout(upright, { edge, at: 0.3 }, 48)).toEqual({ kind: 'bottom' });
		}
	});

	it("FA3: is a side panel on the button's edge on a screen on its side", () => {
		expect(sheetLayout(onItsSide, { edge: 'left', at: 0.9 }, 48)).toEqual({
			kind: 'side',
			side: 'left'
		});
		expect(sheetLayout(onItsSide, { edge: 'right', at: 0 }, 48)).toEqual({
			kind: 'side',
			side: 'right'
		});
	});

	it('FA3: on the side nearer the button when it sits on the top or bottom edge', () => {
		expect(sheetLayout(onItsSide, { edge: 'top', at: 0.2 }, 48)).toEqual({
			kind: 'side',
			side: 'left'
		});
		expect(sheetLayout(onItsSide, { edge: 'bottom', at: 0.8 }, 48)).toEqual({
			kind: 'side',
			side: 'right'
		});
	});

	it('FA7: shows a fade at each end that has more to scroll to, and none when it all fits', () => {
		expect(scrollEdges({ scrollTop: 0, clientHeight: 200, scrollHeight: 200 })).toEqual({
			above: false,
			below: false
		});
		expect(scrollEdges({ scrollTop: 0, clientHeight: 200, scrollHeight: 500 })).toEqual({
			above: false,
			below: true
		});
		expect(scrollEdges({ scrollTop: 150, clientHeight: 200, scrollHeight: 500 })).toEqual({
			above: true,
			below: true
		});
		expect(scrollEdges({ scrollTop: 300, clientHeight: 200, scrollHeight: 500 })).toEqual({
			above: true,
			below: false
		});
	});

	it('DP8: has a tab for every session action, and Session always', () => {
		expect(sheetTabs(CHROME_ACTIONS).map((tab) => tab.label)).toEqual([
			'Keys',
			'Clipboard',
			'Picture',
			'Screen',
			'Session'
		]);
		expect(sheetTabs(['settings', 'disconnect']).map((tab) => tab.value)).toEqual([
			'picture',
			'session'
		]);
		expect(sheetTabs([]).map((tab) => tab.value)).toEqual(['session']);
	});
});
