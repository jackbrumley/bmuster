import { describe, expect, it } from 'vitest';
import {
	handoverFrom,
	PHONE_QUERY,
	popOutFeatures,
	popOutName,
	popOutSize,
	popOutUrl
} from './pop-out.ts';

// SPEC-DESKTOP-POPOUT PF5, PO1.

const SESSION = '33333333-3333-4333-8333-333333333333';

describe('the phone layout', () => {
	it('PF5: every part of the phone query needs a finger and a small side', () => {
		const parts = PHONE_QUERY.split(',').map((part) => part.trim());
		expect(parts).toEqual([
			'(pointer: coarse) and (max-width: 899px)',
			'(pointer: coarse) and (max-height: 599px)'
		]);
	});
});

describe('the pop-out window', () => {
	it('PO1: keeps the picture aspect inside 90% of the screen', () => {
		// A wide picture is bounded by the width: 1728 = 0.9 × 1920.
		expect(popOutSize({ width: 3840, height: 1080 }, { width: 1920, height: 1040 })).toEqual({
			width: 1728,
			height: 486
		});
		// A 16:9 picture on a 16:10 screen is bounded by the height: 0.9 × 1040 = 936.
		expect(popOutSize({ width: 1920, height: 1080 }, { width: 1920, height: 1040 })).toEqual({
			width: 1664,
			height: 936
		});
		// A small picture still fills the room, so it can be read.
		expect(popOutSize({ width: 16, height: 9 }, { width: 1000, height: 1000 })).toEqual({
			width: 900,
			height: 506
		});
	});

	it('PO1: is named per machine and opened as a popup of that size', () => {
		expect(popOutName('m-1')).toBe('bmuster-desktop-m-1');
		expect(popOutName('m-1')).not.toBe(popOutName('m-2'));
		expect(popOutFeatures({ width: 800, height: 450 })).toBe('popup,width=800,height=450');
	});

	it('PO1: carries the session, mode and start time, and reads them back', () => {
		const handover = { sessionId: SESSION, mode: 'control' as const, sinceMs: 1_794_000_000_000 };
		const url = popOutUrl('/machines/m-1/desktop/window', handover);
		expect(url).toBe(
			`/machines/m-1/desktop/window?sessionId=${SESSION}&mode=control&since=1794000000000`
		);
		expect(handoverFrom(new URL(url, 'https://bmuster.test').searchParams)).toEqual(handover);
	});

	it('PO1: an address without a whole handover adopts nothing', () => {
		for (const search of [
			'',
			`?sessionId=${SESSION}&mode=control`,
			`?sessionId=${SESSION}&mode=drive&since=1`,
			'?sessionId=not-a-session&mode=watch&since=1',
			`?sessionId=${SESSION}&mode=watch&since=soon`
		]) {
			expect(handoverFrom(new URLSearchParams(search)), search).toBeUndefined();
		}
	});
});
