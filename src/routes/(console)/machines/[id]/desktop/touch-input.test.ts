import { describe, expect, it, vi } from 'vitest';
import { readTouchMode, saveTouchMode, TOUCH_MODES, touchModeHelp } from './touch-input.ts';

// SPEC-DESKTOP-FLOATING FA20, FA21.

function storage(items: Map<string, string>) {
	vi.stubGlobal('localStorage', {
		getItem: (key: string) => items.get(key) ?? null,
		setItem: (key: string, value: string) => {
			items.set(key, value);
		}
	});
}

describe('the touch input choice', () => {
	it('FA20: offers Trackpad, Tap to click and Fixed cursor, in that order, each with its help', () => {
		expect(TOUCH_MODES.map((mode) => mode.label)).toEqual([
			'Trackpad',
			'Tap to click',
			'Fixed cursor'
		]);
		for (const mode of TOUCH_MODES) {
			expect(touchModeHelp(mode.value).length).toBeGreaterThan(0);
		}
	});

	it('FA21: is Trackpad until chosen, then remembered in this browser', () => {
		const items = new Map<string, string>();
		storage(items);
		expect(readTouchMode()).toBe('trackpad');
		saveTouchMode('fixed');
		expect(items.get('bmuster.desktop.touchInput')).toBe('fixed');
		expect(readTouchMode()).toBe('fixed');
	});

	it('FA21: a bad saved value or blocked storage gives Trackpad, and saving does not throw', () => {
		storage(new Map([['bmuster.desktop.touchInput', 'joystick']]));
		expect(readTouchMode()).toBe('trackpad');
		const blocked = () => {
			throw new Error('SecurityError: storage is blocked');
		};
		vi.stubGlobal('localStorage', { getItem: blocked, setItem: blocked });
		expect(readTouchMode()).toBe('trackpad');
		expect(() => {
			saveTouchMode('touch');
		}).not.toThrow();
	});
});
