import { describe, expect, it, vi } from 'vitest';
import { defaultControls, readControls, rememberControls } from './floating-memory.ts';

// SPEC-DESKTOP-FLOATING FB7, FB15: the floating controls are remembered per device, per view and per machine.

const MACHINE = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

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
		rememberControls('window', MACHINE, moved);
		expect(readControls('window', MACHINE, false)).toEqual(moved);
		expect(readControls('full-screen', MACHINE, false)).toEqual(defaultControls(false));
		expect(JSON.parse(localStorage.getItem('bmuster.desktop.controls.window') ?? 'null')).toEqual(
			moved
		);
	});

	it("FB15: each machine keeps its own; one with nothing saved starts at the device's last-used", () => {
		vi.stubGlobal('localStorage', memoryStorage());
		const first = {
			shown: 'button',
			bar: { x: 0.25, y: 1 },
			button: { edge: 'top', at: 0.75 }
		} as const;
		const second = {
			shown: 'bar',
			bar: { x: 1, y: 0.5 },
			button: { edge: 'left', at: 0.1 }
		} as const;
		rememberControls('full-screen', MACHINE, first);
		// A machine with nothing saved starts where the controls were last left.
		expect(readControls('full-screen', OTHER, false)).toEqual(first);
		rememberControls('full-screen', OTHER, second);
		// Each machine then keeps its own.
		expect(readControls('full-screen', MACHINE, false)).toEqual(first);
		expect(readControls('full-screen', OTHER, false)).toEqual(second);
		// A third machine starts at the last-used one, the second's.
		expect(readControls('full-screen', 'a-third-machine', false)).toEqual(second);
		expect(
			JSON.parse(localStorage.getItem(`bmuster.desktop.controls.full-screen.${MACHINE}`) ?? 'null')
		).toEqual(first);
		// A bad value for this machine falls back to the device's.
		localStorage.setItem(`bmuster.desktop.controls.full-screen.${MACHINE}`, 'not json');
		expect(readControls('full-screen', MACHINE, false)).toEqual(second);
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
			storage.setItem(`bmuster.desktop.controls.full-screen.${MACHINE}`, bad);
			expect(readControls('full-screen', MACHINE, true)).toEqual(defaultControls(true));
		}
		vi.stubGlobal('localStorage', blockedStorage());
		expect(readControls('full-screen', MACHINE, false)).toEqual(defaultControls(false));
		expect(() => {
			rememberControls('full-screen', MACHINE, defaultControls(false));
		}).not.toThrow();
	});
});
