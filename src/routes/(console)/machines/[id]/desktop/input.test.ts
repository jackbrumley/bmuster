import { describe, expect, it } from 'vitest';
import type { InputMessage } from '#lib/domain/desktop/messages.ts';
import { contentBox, KeyFilter, toDisplay, TouchGestures, type Geometry } from './input.ts';

// SPEC-DESKTOP R7 and 5.3.

describe('coordinates (5.3)', () => {
	const box = { left: 100, top: 50, width: 800, height: 600 };

	it('letterboxes a wide picture and maps clicks to display pixels whatever the scale', () => {
		// A 1920x1080 display sent at half size: 960x540, shown in an 800x600 box.
		const picture = { width: 960, height: 540 };
		expect(contentBox(box, picture)).toEqual({ left: 100, top: 125, width: 800, height: 450 });
		const display = { width: 1920, height: 1080 };
		expect(toDisplay({ x: 500, y: 350 }, box, picture, display)).toEqual({ x: 960, y: 540 });
		expect(toDisplay({ x: 100, y: 125 }, box, picture, display)).toEqual({ x: 0, y: 0 });
		// The same click with the stream at full size lands on the same pixel.
		const full = { width: 1920, height: 1080 };
		expect(toDisplay({ x: 500, y: 350 }, box, full, display)).toEqual({ x: 960, y: 540 });
	});

	it('clamps points on the bars beside the picture to its edge', () => {
		const picture = { width: 1000, height: 1000 };
		const display = { width: 1000, height: 1000 };
		expect(toDisplay({ x: 101, y: 60 }, box, picture, display)).toEqual({ x: 0, y: 17 });
		expect(toDisplay({ x: 899, y: 660 }, box, picture, display)).toEqual({ x: 999, y: 999 });
	});
});

function keys() {
	const sent: InputMessage[] = [];
	const timers: (() => void)[] = [];
	const filter = new KeyFilter(
		(message) => sent.push(message),
		(run) => {
			timers.push(run);
			return () => {
				const index = timers.indexOf(run);
				if (index >= 0) timers.splice(index, 1);
			};
		}
	);
	const fire = () => {
		for (const run of timers.splice(0)) run();
	};
	return { sent, filter, fire };
}

describe('AltGr (5.3)', () => {
	it('drops the made-up ControlLeft and sends AltRight as AltGr', () => {
		const { sent, filter } = keys();
		filter.down('ControlLeft', 'Control');
		filter.down('AltRight', 'AltGraph');
		filter.down('KeyQ', '@');
		filter.up('KeyQ', '@');
		filter.up('ControlLeft', 'Control');
		filter.up('AltRight', 'AltGraph');
		expect(sent).toEqual([
			{ type: 'key', code: 'AltRight', key: 'AltGraph', down: true, altGr: true },
			{ type: 'key', code: 'KeyQ', key: '@', down: true, altGr: false },
			{ type: 'key', code: 'KeyQ', key: '@', down: false, altGr: false },
			{ type: 'key', code: 'AltRight', key: 'AltGraph', down: false, altGr: true }
		]);
	});

	it('keeps a real Ctrl, and Ctrl+Alt pressed one after the other', () => {
		const { sent, filter, fire } = keys();
		filter.down('ControlLeft', 'Control');
		fire();
		filter.down('AltRight', 'Alt');
		filter.down('KeyT', 't');
		expect(sent.map((m) => (m.type === 'key' ? [m.code, m.altGr] : m.type))).toEqual([
			['ControlLeft', false],
			['AltRight', false],
			['KeyT', false]
		]);
	});

	it('sends a held ControlLeft at once when another key follows it', () => {
		const { sent, filter } = keys();
		filter.down('ControlLeft', 'Control');
		filter.down('KeyC', 'c');
		expect(sent.map((m) => (m.type === 'key' ? m.code : m.type))).toEqual(['ControlLeft', 'KeyC']);
	});
});

function touches(mode: 'trackpad' | 'touch') {
	const sent: string[] = [];
	const geometry: Geometry = {
		box: { left: 0, top: 0, width: 400, height: 300 },
		picture: { width: 800, height: 600 },
		display: { width: 1600, height: 1200 }
	};
	const gestures = new TouchGestures(
		{
			pointer: (x, y, buttons) => sent.push(`pointer ${x},${y} ${buttons}`),
			wheel: (dx, dy) => sent.push(`wheel ${dx},${dy}`)
		},
		() => geometry
	);
	gestures.mode = mode;
	gestures.position = { x: 800, y: 600 };
	return { sent, gestures };
}

describe('trackpad mode (5.3)', () => {
	it('moves the pointer relatively, scaled to the display', () => {
		const { sent, gestures } = touches('trackpad');
		gestures.down(1, 100, 100, 0);
		gestures.move(1, 110, 95);
		gestures.up(1, 50);
		// 4 display pixels per page pixel; no click after a move.
		expect(sent).toEqual(['pointer 840,580 0']);
	});

	it('taps to click left, two fingers tap to click right, and two fingers scroll', () => {
		const { sent, gestures } = touches('trackpad');
		gestures.down(1, 100, 100, 0);
		gestures.up(1, 80);
		gestures.down(1, 100, 100, 1000);
		gestures.down(2, 150, 100, 1010);
		gestures.up(1, 1090);
		gestures.up(2, 1100);
		gestures.down(1, 100, 100, 2000);
		gestures.down(2, 150, 100, 2000);
		gestures.move(1, 100, 80);
		gestures.move(2, 150, 80);
		gestures.up(1, 2100);
		gestures.up(2, 2100);
		expect(sent).toEqual([
			'pointer 800,600 1',
			'pointer 800,600 0',
			'pointer 800,600 2',
			'pointer 800,600 0',
			'wheel 0,40',
			'wheel 0,40'
		]);
	});

	it('holds the left button for a drag that starts just after a tap', () => {
		const { sent, gestures } = touches('trackpad');
		gestures.down(1, 100, 100, 0);
		gestures.up(1, 50);
		gestures.down(1, 100, 100, 200);
		gestures.move(1, 120, 100);
		gestures.up(1, 600);
		expect(sent).toEqual([
			'pointer 800,600 1',
			'pointer 800,600 0',
			'pointer 800,600 1',
			'pointer 880,600 1',
			'pointer 880,600 0'
		]);
	});
});

describe('touch mode (5.3)', () => {
	it('moves the pointer to the tap and clicks there', () => {
		const { sent, gestures } = touches('touch');
		gestures.down(1, 200, 150, 0);
		gestures.up(1, 60);
		expect(sent).toEqual(['pointer 800,600 0', 'pointer 800,600 1', 'pointer 800,600 0']);
	});
});
