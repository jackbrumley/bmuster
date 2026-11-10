import { describe, expect, it, vi } from 'vitest';
import {
	clampCorner,
	DEFAULT_POSITION,
	readPosition,
	savePosition,
	snapped
} from './floating-position.ts';

// SPEC-DESKTOP-FLOATING F2, F3.

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

describe('the floating button position', () => {
	it('F3: is saved and read back', () => {
		vi.stubGlobal('localStorage', memoryStorage());
		expect(readPosition()).toEqual(DEFAULT_POSITION);
		savePosition({ side: 'left', at: 0.25 });
		expect(readPosition()).toEqual({ side: 'left', at: 0.25 });
	});

	it('F3: blocked storage or a bad value gives the default, right edge halfway', () => {
		const storage = memoryStorage();
		vi.stubGlobal('localStorage', storage);
		for (const bad of ['not json', '{"side":"top","at":0.5}', '{"side":"left","at":3}']) {
			storage.setItem('bmuster.desktop.floatingButton', bad);
			expect(readPosition()).toEqual({ side: 'right', at: 0.5 });
		}
		vi.stubGlobal('localStorage', blockedStorage());
		expect(readPosition()).toEqual(DEFAULT_POSITION);
		expect(() => {
			savePosition({ side: 'left', at: 0 });
		}).not.toThrow();
	});

	it('F2: snaps to the nearer edge and keeps the height', () => {
		const area = { width: 351, height: 643 };
		expect(snapped({ x: 40, y: 0 }, area, 48)).toEqual({ side: 'left', at: 0 });
		expect(snapped({ x: 200, y: 595 }, area, 48)).toEqual({ side: 'right', at: 1 });
		expect(snapped({ x: 100, y: 297.5 }, area, 48)).toEqual({ side: 'left', at: 0.5 });
		expect(snapped({ x: 100, y: 10 }, { width: 351, height: 40 }, 48).at).toBe(0.5);
	});

	it('F2: keeps a dragged button inside the area', () => {
		const area = { width: 300, height: 500 };
		expect(clampCorner({ x: -20, y: 900 }, area, 48)).toEqual({ x: 0, y: 452 });
		expect(clampCorner({ x: 400, y: -5 }, area, 48)).toEqual({ x: 252, y: 0 });
	});
});
