import { describe, expect, it } from 'vitest';
import {
	availableActions,
	CHROME_ACTIONS,
	FILE_ACTIONS,
	type ActionState
} from './session-actions.ts';

// SPEC-DESKTOP 23: which session actions a view offers now.

const CONTROLLING: ActionState = {
	running: true,
	watchOnly: false,
	canControl: true,
	canSend: true,
	filesWaiting: true,
	transfersOpen: false,
	displays: 2
};

describe('the session actions', () => {
	it('DP8: a running control session with files waiting and two displays offers every action', () => {
		expect(availableActions(CONTROLLING)).toEqual([...CHROME_ACTIONS]);
	});

	it('DP2: a link without files offers everything but the file actions', () => {
		expect(availableActions({ ...CONTROLLING, canSend: false, filesWaiting: false })).toEqual(
			CHROME_ACTIONS.filter((action) => !FILE_ACTIONS.includes(action))
		);
	});

	it('watching offers no keys, clipboard or files; no session offers nothing', () => {
		expect(
			availableActions({ ...CONTROLLING, watchOnly: true, canSend: false, filesWaiting: false })
		).toEqual(['mode', 'settings', 'display', 'disconnect']);
		expect(
			availableActions({
				...CONTROLLING,
				running: false,
				canSend: false,
				filesWaiting: false,
				displays: 0
			})
		).toEqual([]);
	});

	it('one display has no picker; an open Transfers panel stays closable', () => {
		expect(availableActions({ ...CONTROLLING, displays: 1 })).not.toContain('display');
		expect(
			availableActions({ ...CONTROLLING, canSend: false, filesWaiting: false, transfersOpen: true })
		).toContain('transfers');
	});
});
