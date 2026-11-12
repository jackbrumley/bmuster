import { describe, expect, it, vi } from 'vitest';
import { dismissHint, hintDismissed } from './gesture-hint.ts';

// SPEC-DESKTOP-FLOATING FA14.

describe('the touch gestures hint', () => {
	it('FA14: shows until it is dismissed, then stays dismissed in this browser', () => {
		const items = new Map<string, string>();
		vi.stubGlobal('localStorage', {
			getItem: (key: string) => items.get(key) ?? null,
			setItem: (key: string, value: string) => {
				items.set(key, value);
			}
		});
		expect(hintDismissed()).toBe(false);
		dismissHint();
		expect(hintDismissed()).toBe(true);
		expect(items.get('bmuster.desktop.gestureHint')).toBe('dismissed');
	});

	it('FA14: with storage blocked it counts as not dismissed, and dismissing does not throw', () => {
		const blocked = () => {
			throw new Error('SecurityError: storage is blocked');
		};
		vi.stubGlobal('localStorage', { getItem: blocked, setItem: blocked });
		expect(hintDismissed()).toBe(false);
		expect(() => {
			dismissHint();
		}).not.toThrow();
	});
});
