import { describe, expect, it, vi } from 'vitest';
import { readAutoStart, saveAutoStart, SUSTAINED_MS, sustainedStart } from './auto-quality.ts';

// SPEC-DESKTOP 20: Q5.

describe('where Auto starts', () => {
	it('Q5: a level counts once Auto has held it for 20 s; Extra high starts the next session there', () => {
		expect(sustainedStart('extra-high', 0, SUSTAINED_MS - 1)).toBeUndefined();
		expect(sustainedStart('extra-high', 0, SUSTAINED_MS)).toBe('extra-high');
		// Anything less held as long starts the next session at High again.
		expect(sustainedStart('high', 0, SUSTAINED_MS)).toBe('high');
		expect(sustainedStart('medium', 0, SUSTAINED_MS)).toBe('high');
		expect(sustainedStart('low', 1000, 1000 + SUSTAINED_MS)).toBe('high');
	});

	it('Q5: is remembered per machine in this browser, High until a session held Extra high', () => {
		const items = new Map<string, string>();
		vi.stubGlobal('localStorage', {
			getItem: (key: string) => items.get(key) ?? null,
			setItem: (key: string, value: string) => {
				items.set(key, value);
			}
		});
		expect(readAutoStart('m-1')).toBe('high');
		saveAutoStart('m-1', 'extra-high');
		expect(readAutoStart('m-1')).toBe('extra-high');
		expect(readAutoStart('m-2')).toBe('high');
		saveAutoStart('m-1', 'high');
		expect(readAutoStart('m-1')).toBe('high');
	});

	it('Q5: with storage blocked every session starts at High, and saving does not throw', () => {
		const blocked = () => {
			throw new Error('SecurityError: storage is blocked');
		};
		vi.stubGlobal('localStorage', { getItem: blocked, setItem: blocked });
		expect(readAutoStart('m-1')).toBe('high');
		expect(() => {
			saveAutoStart('m-1', 'extra-high');
		}).not.toThrow();
	});
});
