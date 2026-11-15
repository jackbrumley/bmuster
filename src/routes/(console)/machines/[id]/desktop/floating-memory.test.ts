import { describe, expect, it, vi } from 'vitest';
import { defaultControls, readControls, rememberControls } from './floating-memory.ts';

// SPEC-DESKTOP-FLOATING FB7: the floating controls are remembered per device and per view.

function memoryStorage(): Storage {
	const items = new Map<string, string>();
	return {
		get length() {
			return items.size;
		},
		clear: () => {
			items.clear();
		},
		getItem: (key) => items.get(key) ?? null,
		key: (index) => [...items.keys()][index] ?? null,
		removeItem: (key) => {
			items.delete(key);
		},
		setItem: (key, value) => {
			items.set(key, value);
		}
	};
}

function blockedStorage(): Storage {
	const blocked = () => {
		throw new Error('SecurityError: storage is blocked');
	};
	return {
		length: 0,
		clear: blocked,
		getItem: blocked,
		key: blocked,
		removeItem: blocked,
		setItem: blocked
	};
}

describe('the floating controls memory', () => {
	it('FB7: defaults to the bar at the top centre with a mouse, the button on touch', () => {
		expect(defaultControls(false)).toEqual({
			shown: 'bar',
			bar: { x: 0.5, y: 0 },
			button: { edge: 'right', at: 0.5 }
		});
		expect(defaultControls(true).shown).toBe('button');
	});

	it('FB7: is saved and read back, apart for full screen and the pop-out', () => {
		vi.stubGlobal('localStorage', memoryStorage());
		const moved = {
			shown: 'button',
			bar: { x: 0.25, y: 1 },
			button: { edge: 'top', at: 0.75 }
		} as const;
		rememberControls('window', moved);
		expect(readControls('window', false)).toEqual(moved);
		expect(readControls('full-screen', false)).toEqual(defaultControls(false));
		expect(JSON.parse(localStorage.getItem('bmuster.desktop.controls.window') ?? 'null')).toEqual(
			moved
		);
	});

	it('FB7: blocked storage or a bad value gives the defaults', () => {
		const storage = memoryStorage();
		vi.stubGlobal('localStorage', storage);
		for (const bad of [
			'not json',
			'{"shown":"bar"}',
			'{"shown":"sideways","bar":{"x":0,"y":0},"button":{"edge":"left","at":0}}',
			'{"shown":"bar","bar":{"x":2,"y":0},"button":{"edge":"left","at":0}}',
			'{"shown":"bar","bar":{"x":0,"y":0},"button":{"edge":"middle","at":0}}'
		]) {
			storage.setItem('bmuster.desktop.controls.full-screen', bad);
			expect(readControls('full-screen', true)).toEqual(defaultControls(true));
		}
		vi.stubGlobal('localStorage', blockedStorage());
		expect(readControls('full-screen', false)).toEqual(defaultControls(false));
		expect(() => {
			rememberControls('full-screen', defaultControls(false));
		}).not.toThrow();
	});
});
