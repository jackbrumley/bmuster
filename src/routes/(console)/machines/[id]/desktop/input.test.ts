import { describe, expect, it } from 'vitest';
import type { InputMessage } from '#lib/domain/desktop/messages.ts';
import { contentBox, KeyFilter, toDisplay } from './input.ts';

// SPEC-DESKTOP R7 and 5.3 (touch gestures: touch-gestures.test.ts).

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
