import { describe, expect, it } from 'vitest';
import {
	attentionOf,
	availableActions,
	CHROME_ACTIONS,
	connectionStatus,
	linkHealth,
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

describe('the session status', () => {
	it('FB1: a flowing picture gives its figures apart, so the bars can give them a fixed width', () => {
		const live = { kind: 'live', ready: true, sinceMs: 0 } as const;
		const steady = { stalled: false, autoLevel: undefined };
		expect(
			connectionStatus(live, { ...steady, throughput: { fps: 9, bytesPerSecond: 5 * 1024 } })
		).toEqual({ kind: 'figures', fps: 9, kilobytes: 5, health: 'good' });
		expect(
			connectionStatus(live, {
				stalled: true,
				autoLevel: undefined,
				throughput: { fps: 30, bytesPerSecond: 1234.4 * 1024 }
			})
		).toEqual({ kind: 'figures', fps: 30, kilobytes: 1234, health: 'struggling' });
		expect(connectionStatus({ kind: 'reconnecting' }, undefined)).toEqual({
			kind: 'text',
			text: 'Reconnecting…'
		});
		expect(connectionStatus({ kind: 'live', ready: false, sinceMs: 0 }, undefined)).toEqual({
			kind: 'text',
			text: 'Waiting for the machine…'
		});
	});
});

describe('the link health', () => {
	it('FB12: a stall or Auto at Low is struggling, Auto at Medium is slow, anything else good', () => {
		expect(linkHealth({ stalled: false, autoLevel: undefined })).toBe('good');
		expect(linkHealth({ stalled: false, autoLevel: 'extra-high' })).toBe('good');
		expect(linkHealth({ stalled: false, autoLevel: 'high' })).toBe('good');
		expect(linkHealth({ stalled: false, autoLevel: 'medium' })).toBe('slow');
		expect(linkHealth({ stalled: false, autoLevel: 'low' })).toBe('struggling');
		expect(linkHealth({ stalled: true, autoLevel: 'high' })).toBe('struggling');
		expect(linkHealth({ stalled: true, autoLevel: undefined })).toBe('struggling');
	});
});

describe('what needs attention', () => {
	it('FB6: files waiting come first, then a clipboard notice; nothing otherwise', () => {
		const quiet = { pending: false, error: undefined };
		expect(attentionOf(undefined, quiet)).toBeUndefined();
		expect(
			attentionOf('2 files copied on the machine', { pending: true, error: undefined })
		).toEqual({ kind: 'files', text: '2 files copied on the machine' });
		expect(attentionOf(undefined, { pending: true, error: undefined })).toEqual({
			kind: 'clipboard',
			text: 'text copied on the machine, tap to use it here'
		});
		expect(
			attentionOf(undefined, { pending: false, error: 'The machine has no clipboard.' })
		).toEqual({ kind: 'clipboard', text: 'clipboard: The machine has no clipboard.' });
	});
});
