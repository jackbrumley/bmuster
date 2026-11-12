import { describe, expect, it, vi } from 'vitest';
import {
	clampCorner,
	DEFAULT_POSITION,
	readPosition,
	savePosition,
	snapped
} from './floating-position.ts';

// SPEC-DESKTOP-FLOATING F2, F3, FA1, FA2.

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

const KEY = 'bmuster.desktop.floatingButton';

describe('the floating button position', () => {
	it('F3: is saved and read back', () => {
		vi.stubGlobal('localStorage', memoryStorage());
		expect(readPosition()).toEqual(DEFAULT_POSITION);
		savePosition({ edge: 'top', at: 0.25 });
		expect(readPosition()).toEqual({ edge: 'top', at: 0.25 });
	});

	it('FA2: a position saved before the top and bottom edges reads as the same place', () => {
		const storage = memoryStorage();
		vi.stubGlobal('localStorage', storage);
		storage.setItem(KEY, '{"side":"left","at":0.25}');
		expect(readPosition()).toEqual({ edge: 'left', at: 0.25 });
		storage.setItem(KEY, '{"side":"right","at":1}');
		expect(readPosition()).toEqual({ edge: 'right', at: 1 });
	});

	it('FA2: blocked storage or a bad value gives the default, right edge halfway', () => {
		const storage = memoryStorage();
		vi.stubGlobal('localStorage', storage);
		for (const bad of [
			'not json',
			'{"side":"top","at":0.5}',
			'{"edge":"middle","at":0.5}',
			'{"edge":"left","at":3}'
		]) {
			storage.setItem(KEY, bad);
			expect(readPosition()).toEqual({ edge: 'right', at: 0.5 });
		}
		vi.stubGlobal('localStorage', blockedStorage());
		expect(readPosition()).toEqual(DEFAULT_POSITION);
		expect(() => {
			savePosition({ edge: 'left', at: 0 });
		}).not.toThrow();
	});

	it('FA1: snaps to the nearest of the four edges and keeps its place along it', () => {
		// The button can travel 303 across and 595 down.
		const area = { width: 351, height: 643 };
		expect(snapped({ x: 10, y: 297.5 }, area, 48)).toEqual({ edge: 'left', at: 0.5 });
		expect(snapped({ x: 280, y: 595 * 0.25 }, area, 48)).toEqual({ edge: 'right', at: 0.25 });
		expect(snapped({ x: 151.5, y: 4 }, area, 48)).toEqual({ edge: 'top', at: 0.5 });
		expect(snapped({ x: 75.75, y: 594 }, area, 48)).toEqual({ edge: 'bottom', at: 0.25 });
		// A corner tie goes to the side edge.
		expect(snapped({ x: 0, y: 0 }, area, 48)).toEqual({ edge: 'left', at: 0 });
		// No room to travel along the edge: halfway.
		expect(snapped({ x: 0, y: 0 }, { width: 40, height: 40 }, 48).at).toBe(0.5);
	});

	it('F2: keeps a dragged button inside the area', () => {
		const area = { width: 300, height: 500 };
		expect(clampCorner({ x: -20, y: 900 }, area, 48)).toEqual({ x: 0, y: 452 });
		expect(clampCorner({ x: 400, y: -5 }, area, 48)).toEqual({ x: 252, y: 0 });
	});
});
