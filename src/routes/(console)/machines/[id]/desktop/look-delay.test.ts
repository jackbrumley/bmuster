import { describe, expect, it } from 'vitest';
import { lookDelayMs } from './desktop-files.svelte.ts';

describe('copied-files watch (SPEC-SESSION-FILES SF27)', () => {
	it('SF27: backs off after refused looks, from 4 s doubling to a minute, and not at all after a good one', () => {
		expect(lookDelayMs(0)).toBe(0);
		expect(lookDelayMs(1)).toBe(4_000);
		expect(lookDelayMs(2)).toBe(8_000);
		expect(lookDelayMs(5)).toBe(60_000);
		expect(lookDelayMs(20)).toBe(60_000);
	});
});
