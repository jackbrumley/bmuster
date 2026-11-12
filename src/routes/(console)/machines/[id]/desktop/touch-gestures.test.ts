import { describe, expect, it } from 'vitest';
import { toPage } from './input.ts';
import {
	HOLD_AFTER_TAP_MS,
	TAP_CLICK_DELAY_MS,
	TouchGestures,
	twoFingerIntent,
	type Geometry,
	type TouchMode
} from './touch-gestures.ts';
import { zoomedBox, type Zoom } from './zoom.ts';

// SPEC-DESKTOP 5.3; SPEC-DESKTOP-FLOATING FA10, FA12, FA13, FA16–FA18, FA22–FA24.

/** A 400x300 box showing an 800x600 picture of a 1600x1200 display: 4 display pixels per page pixel. */
function touches(mode: TouchMode) {
	const sent: string[] = [];
	const zooms: Zoom[] = [];
	const timers: (() => void)[] = [];
	const delays: number[] = [];
	const geometry: Geometry = {
		box: { left: 0, top: 0, width: 400, height: 300 },
		picture: { width: 800, height: 600 },
		display: { width: 1600, height: 1200 }
	};
	const gestures = new TouchGestures(
		{
			pointer: (x, y, buttons) => sent.push(`pointer ${x},${y} ${buttons}`),
			wheel: (dx, dy) => sent.push(`wheel ${dx},${dy}`),
			zoom: (zoom) => zooms.push(zoom)
		},
		() => geometry,
		(run, ms) => {
			timers.push(run);
			delays.push(ms);
			return () => {
				const index = timers.indexOf(run);
				if (index >= 0) timers.splice(index, 1);
			};
		}
	);
	gestures.mode = mode;
	gestures.position = { x: 800, y: 600 };
	/** Lets every waiting timer run, as if enough time passed. */
	const elapse = () => {
		for (const run of timers.splice(0)) run();
	};
	/** Where the remote pointer shows on the page now. */
	const shown = () =>
		toPage(
			gestures.position,
			zoomedBox(geometry.box, gestures.zoom),
			geometry.picture,
			geometry.display
		);
	return { sent, zooms, gestures, elapse, delays, shown };
}

/** Two fingers from 100 apart at (0,0) and (100,0) spread to 200 apart: 2x, anchored at the corner. */
function zoomToTwo(gestures: TouchGestures, at: number): void {
	gestures.down(1, 0, 0, at);
	gestures.down(2, 100, 0, at);
	gestures.move(2, 200, 0);
	gestures.up(1, at + 200);
	gestures.up(2, at + 200);
}

describe('trackpad mode (5.3)', () => {
	it('moves the pointer relatively, scaled to the display', () => {
		const { sent, gestures } = touches('trackpad');
		gestures.down(1, 100, 100, 0);
		gestures.move(1, 110, 95);
		gestures.up(1, 50);
		expect(sent).toEqual(['pointer 840,580 0']);
	});

	it('taps to click left, two fingers tap to click right, and two fingers scroll', () => {
		const { sent, gestures, elapse } = touches('trackpad');
		gestures.down(1, 100, 100, 0);
		gestures.up(1, 80);
		elapse();
		gestures.down(1, 100, 100, 1000);
		gestures.down(2, 150, 100, 1010);
		gestures.up(1, 1090);
		gestures.up(2, 1100);
		gestures.down(1, 100, 100, 2000);
		gestures.down(2, 150, 100, 2000);
		gestures.move(1, 100, 80);
		gestures.move(2, 150, 80);
		gestures.move(1, 100, 60);
		gestures.up(1, 2100);
		gestures.up(2, 2100);
		// The pair's midpoint moves 10, 10 and 10: the first 10 decide it is a scroll.
		expect(sent).toEqual([
			'pointer 800,600 1',
			'pointer 800,600 0',
			'pointer 800,600 2',
			'pointer 800,600 0',
			'wheel 0,40',
			'wheel 0,40'
		]);
	});

	it('FA16: a single tap clicks once, when the tap click delay has passed', () => {
		const { sent, gestures, elapse, delays } = touches('trackpad');
		gestures.down(1, 100, 100, 0);
		gestures.up(1, 80);
		expect(sent).toEqual([]);
		expect(delays).toContain(TAP_CLICK_DELAY_MS);
		elapse();
		expect(sent).toEqual(['pointer 800,600 1', 'pointer 800,600 0']);
		elapse();
		expect(sent).toHaveLength(2);
	});

	it('FA16: tap, tap and release is exactly two clicks at the same pixel, leaving no button down', () => {
		const { sent, gestures, elapse } = touches('trackpad');
		gestures.down(1, 100, 100, 0);
		gestures.up(1, 80);
		// Down 200 ms after the lift, wobbling 4px, up 120 ms later: no movement goes between the clicks.
		gestures.down(1, 102, 101, 280);
		gestures.move(1, 104, 100);
		gestures.up(1, 400);
		elapse();
		expect(sent).toEqual([
			'pointer 800,600 1',
			'pointer 800,600 0',
			'pointer 800,600 1',
			'pointer 800,600 0'
		]);
	});

	it('FA16: a two-finger gesture straight after a tap still sends the tap as one click', () => {
		const { sent, gestures, elapse } = touches('trackpad');
		gestures.down(1, 100, 100, 0);
		gestures.up(1, 80);
		gestures.down(1, 100, 100, 150);
		gestures.down(2, 150, 100, 160);
		expect(sent).toEqual(['pointer 800,600 1', 'pointer 800,600 0']);
		gestures.up(1, 200);
		gestures.up(2, 200);
		elapse();
		expect(sent).toEqual([
			'pointer 800,600 1',
			'pointer 800,600 0',
			'pointer 800,600 2',
			'pointer 800,600 0'
		]);
	});

	it('FA17: tap, then touch and hold is exactly one left button down until the finger lifts, with no click before it', () => {
		const { sent, gestures, elapse, delays } = touches('trackpad');
		gestures.down(1, 100, 100, 0);
		gestures.up(1, 50);
		gestures.down(1, 100, 100, 200);
		expect(sent).toEqual([]);
		expect(delays).toContain(HOLD_AFTER_TAP_MS);
		elapse();
		expect(sent).toEqual(['pointer 800,600 1']);
		gestures.move(1, 120, 100);
		gestures.up(1, 900);
		elapse();
		expect(sent).toEqual(['pointer 800,600 1', 'pointer 880,600 1', 'pointer 880,600 0']);
	});

	it('FA17: tap, then a second touch that moves past the slop presses at once and drags by the whole movement', () => {
		const { sent, gestures, elapse } = touches('trackpad');
		gestures.down(1, 100, 100, 0);
		gestures.up(1, 50);
		gestures.down(1, 100, 100, 50 + TAP_CLICK_DELAY_MS - 10);
		gestures.move(1, 105, 100);
		expect(sent).toEqual([]);
		gestures.move(1, 120, 100);
		gestures.move(1, 130, 100);
		gestures.up(1, 900);
		elapse();
		expect(sent).toEqual([
			'pointer 800,600 1',
			'pointer 880,600 1',
			'pointer 920,600 1',
			'pointer 920,600 0'
		]);
	});

	it('FA17: a touch after the tap click delay is a fresh gesture: the tap clicks, then the finger moves the pointer', () => {
		const { sent, gestures } = touches('trackpad');
		gestures.down(1, 100, 100, 0);
		gestures.up(1, 50);
		gestures.down(1, 100, 100, 50 + TAP_CLICK_DELAY_MS + 10);
		gestures.move(1, 120, 100);
		gestures.up(1, 900);
		expect(sent).toEqual(['pointer 800,600 1', 'pointer 800,600 0', 'pointer 880,600 0']);
	});
});

describe('touch mode (5.3)', () => {
	it('moves the pointer to the tap and clicks there', () => {
		const { sent, gestures } = touches('touch');
		gestures.down(1, 200, 150, 0);
		gestures.up(1, 60);
		expect(sent).toEqual(['pointer 800,600 0', 'pointer 800,600 1', 'pointer 800,600 0']);
	});

	it('FA16: a second tap next to the first clicks the same pixel again', () => {
		const { sent, gestures } = touches('touch');
		gestures.down(1, 200, 150, 0);
		gestures.up(1, 60);
		gestures.down(1, 202, 153, 200);
		gestures.up(1, 260);
		expect(sent).toEqual([
			'pointer 800,600 0',
			'pointer 800,600 1',
			'pointer 800,600 0',
			'pointer 800,600 0',
			'pointer 800,600 1',
			'pointer 800,600 0'
		]);
	});
});

describe('edge pan while zoomed', () => {
	it('FA18: in trackpad mode the pointer never leaves the visible picture', () => {
		const { sent, gestures } = touches('trackpad');
		zoomToTwo(gestures, 0);
		// At 2x from the corner the view shows display x 0–799 and y 0–599.
		gestures.down(1, 100, 100, 1000);
		gestures.move(1, 120, 110);
		expect(sent).toEqual(['pointer 799,599 0']);
	});

	it('FA18: with the finger still in the band, the view keeps panning and the pointer travels with it', () => {
		const { sent, gestures, shown } = touches('trackpad');
		zoomToTwo(gestures, 0);
		gestures.position = { x: 700, y: 300 };
		gestures.down(1, 100, 100, 1000);
		gestures.move(1, 115, 100);
		// The pointer shows at page (365,150): 65% into the right band, 585 page pixels a second.
		expect(shown()).toEqual({ x: 365, y: 150 });
		sent.length = 0;
		expect(gestures.edgePan(100)).toBe(true);
		expect(gestures.zoom).toEqual({ scale: 2, x: -58.5, y: 0 });
		expect(gestures.edgePan(100)).toBe(true);
		expect(gestures.zoom).toEqual({ scale: 2, x: -117, y: 0 });
		// The remote pointer moved the view's 117 display pixels and still shows in the same place.
		expect(sent).toEqual(['pointer 847,300 0', 'pointer 964,300 0']);
		expect(shown()).toEqual({ x: 365, y: 150 });
		// Back in the dead zone the view stops, though the frames keep coming while the finger is down.
		gestures.move(1, 50, 100);
		expect(shown()).toEqual({ x: 300, y: 150 });
		sent.length = 0;
		expect(gestures.edgePan(100)).toBe(true);
		expect(gestures.zoom).toEqual({ scale: 2, x: -117, y: 0 });
		expect(sent).toEqual([]);
		gestures.up(1, 1500);
		expect(gestures.edgePan(100)).toBe(false);
	});

	it('FA18: it stops at the picture edge, the pointer at the edge of the screen', () => {
		const { gestures, shown } = touches('trackpad');
		zoomToTwo(gestures, 0);
		gestures.position = { x: 700, y: 300 };
		gestures.down(1, 100, 100, 1000);
		gestures.move(1, 400, 100);
		for (let frame = 0; frame < 100; frame += 1) {
			gestures.edgePan(50);
		}
		expect(gestures.zoom).toEqual({ scale: 2, x: -400, y: 0 });
		expect(gestures.position).toEqual({ x: 1599, y: 300 });
		expect(shown().x).toBeLessThan(400);
	});

	it('FA18: a held drag pans too, with the button still down', () => {
		const { sent, gestures, elapse } = touches('trackpad');
		zoomToTwo(gestures, 0);
		gestures.position = { x: 700, y: 300 };
		gestures.down(1, 100, 100, 1000);
		gestures.up(1, 1050);
		gestures.down(1, 100, 100, 1100);
		elapse();
		gestures.move(1, 115, 100);
		sent.length = 0;
		expect(gestures.edgePan(100)).toBe(true);
		gestures.up(1, 1500);
		expect(sent).toEqual(['pointer 847,300 1', 'pointer 847,300 0']);
	});

	it('FA18: nothing pans at 1x, or before the finger moves (a tap)', () => {
		const flat = touches('trackpad');
		flat.gestures.position = { x: 1590, y: 600 };
		flat.gestures.down(1, 100, 100, 0);
		flat.gestures.move(1, 120, 100);
		expect(flat.gestures.edgePan(100)).toBe(false);

		const { gestures } = touches('trackpad');
		zoomToTwo(gestures, 0);
		gestures.position = { x: 780, y: 300 };
		gestures.down(1, 100, 100, 1000);
		expect(gestures.edgePan(100)).toBe(true);
		expect(gestures.zoom).toEqual({ scale: 2, x: 0, y: 0 });
	});

	it('FA18: in touch mode a drag held near the edge pans, and the pointer follows what is under the finger', () => {
		const { sent, gestures } = touches('touch');
		zoomToTwo(gestures, 0);
		gestures.down(1, 370, 150, 1000);
		gestures.move(1, 390, 150);
		sent.length = 0;
		expect(gestures.edgePan(100)).toBe(true);
		expect(gestures.zoom).toEqual({ scale: 2, x: -81, y: 0 });
		expect(sent).toEqual(['pointer 942,300 1']);
	});

	it('FA18: the fixed cursor never edge pans', () => {
		const { gestures } = touches('fixed');
		zoomToTwo(gestures, 0);
		gestures.down(1, 100, 100, 1000);
		gestures.move(1, 120, 100);
		expect(gestures.edgePan(100)).toBe(false);
	});
});

describe('fixed cursor (FA22–FA24)', () => {
	it('FA22: a finger moves the picture under the centre, and the pointer is the pixel there', () => {
		const { sent, zooms, gestures } = touches('fixed');
		gestures.down(1, 100, 100, 0);
		gestures.move(1, 120, 100);
		gestures.up(1, 500);
		expect(zooms.at(-1)).toEqual({ scale: 1, x: 20, y: 0 });
		expect(sent).toEqual(['pointer 720,600 0']);
	});

	it('FA22: a tap clicks at the centre after the delay, a double tap double-clicks, and a double tap held drags with no click before it', () => {
		const { sent, gestures, elapse } = touches('fixed');
		gestures.down(1, 100, 100, 0);
		gestures.up(1, 60);
		expect(sent).toEqual([]);
		elapse();
		expect(sent).toEqual(['pointer 800,600 1', 'pointer 800,600 0']);
		sent.length = 0;
		gestures.down(1, 100, 100, 1000);
		gestures.up(1, 1060);
		gestures.down(1, 100, 100, 1200);
		gestures.up(1, 1260);
		elapse();
		expect(sent).toEqual([
			'pointer 800,600 1',
			'pointer 800,600 0',
			'pointer 800,600 1',
			'pointer 800,600 0'
		]);
		sent.length = 0;
		gestures.down(1, 100, 100, 2000);
		gestures.up(1, 2060);
		gestures.down(1, 100, 100, 2200);
		elapse();
		gestures.move(1, 80, 100);
		gestures.up(1, 3000);
		elapse();
		expect(sent).toEqual(['pointer 800,600 1', 'pointer 880,600 1', 'pointer 880,600 0']);
	});

	it('FA23: a pinch zooms about the centre, keeping the pointer on its pixel', () => {
		const { sent, gestures } = touches('fixed');
		zoomToTwo(gestures, 0);
		expect(gestures.zoom).toEqual({ scale: 2, x: -200, y: -150 });
		expect(sent).toEqual([]);
	});

	it('FA23: zoomed, two fingers moving together still scroll', () => {
		const { sent, gestures } = touches('fixed');
		zoomToTwo(gestures, 0);
		gestures.down(1, 100, 100, 1000);
		gestures.down(2, 150, 100, 1000);
		gestures.move(1, 100, 80);
		gestures.move(2, 150, 80);
		gestures.up(1, 1100);
		gestures.up(2, 1100);
		expect(sent).toEqual(['wheel 0,40']);
		expect(gestures.zoom).toEqual({ scale: 2, x: -200, y: -150 });
	});

	it('FA24: a long drag reaches the corner of the display, the picture moving past its edge', () => {
		const { sent, gestures } = touches('fixed');
		gestures.down(1, 0, 0, 0);
		gestures.move(1, 400, 400);
		gestures.up(1, 500);
		expect(gestures.zoom).toEqual({ scale: 1, x: 200, y: 150 });
		expect(sent).toEqual(['pointer 0,0 0']);
	});

	it('FA24: switching to the fixed cursor centres the view on the pointer, which does not jump', () => {
		const { sent, gestures, elapse } = touches('fixed');
		gestures.position = { x: 400, y: 300 };
		gestures.down(1, 100, 100, 0);
		expect(gestures.zoom).toEqual({ scale: 1, x: 100, y: 75 });
		gestures.up(1, 50);
		elapse();
		expect(sent).toEqual(['pointer 400,300 1', 'pointer 400,300 0']);
	});
});

describe('long press', () => {
	it('FA10: right-clicks where the pointer is, in trackpad mode', () => {
		const { sent, gestures, elapse } = touches('trackpad');
		gestures.down(1, 100, 100, 0);
		gestures.move(1, 104, 100);
		elapse();
		gestures.up(1, 700);
		expect(sent).toEqual(['pointer 816,600 0', 'pointer 816,600 2', 'pointer 816,600 0']);
	});

	it('FA10: right-clicks under the finger, in touch mode', () => {
		const { sent, gestures, elapse } = touches('touch');
		gestures.down(1, 50, 25, 0);
		elapse();
		gestures.up(1, 700);
		expect(sent).toEqual(['pointer 200,100 0', 'pointer 200,100 2', 'pointer 200,100 0']);
	});

	it('FA10: a press that moves or lifts before the time does not right-click', () => {
		const moving = touches('trackpad');
		moving.gestures.down(1, 100, 100, 0);
		moving.gestures.move(1, 130, 100);
		moving.elapse();
		moving.gestures.up(1, 700);
		expect(moving.sent).toEqual(['pointer 920,600 0']);

		const lifted = touches('trackpad');
		lifted.gestures.down(1, 100, 100, 0);
		lifted.gestures.up(1, 100);
		lifted.elapse();
		expect(lifted.sent).toEqual(['pointer 800,600 1', 'pointer 800,600 0']);
	});
});

describe('two fingers and the zoom', () => {
	it('FA12: tells a scroll from a pinch, and always pinches when zoomed', () => {
		const from = [
			{ x: 100, y: 100 },
			{ x: 200, y: 100 }
		] as const;
		expect(twoFingerIntent(from, from, false)).toBe('undecided');
		const together = [
			{ x: 100, y: 130 },
			{ x: 200, y: 130 }
		] as const;
		expect(twoFingerIntent(from, together, false)).toBe('scroll');
		const apart = [
			{ x: 80, y: 100 },
			{ x: 230, y: 100 }
		] as const;
		expect(twoFingerIntent(from, apart, false)).toBe('zoom');
		expect(twoFingerIntent(from, together, true)).toBe('zoom');
	});

	it('FA12: spreading zooms the picture instead of scrolling', () => {
		const { sent, zooms, gestures } = touches('trackpad');
		zoomToTwo(gestures, 0);
		expect(sent).toEqual([]);
		expect(zooms.at(-1)).toEqual({ scale: 2, x: 0, y: 0 });
		expect(gestures.zoom).toEqual({ scale: 2, x: 0, y: 0 });
	});

	it('FA12: zoomed, two fingers moving together pan the picture', () => {
		const { sent, gestures } = touches('trackpad');
		zoomToTwo(gestures, 0);
		gestures.down(1, 200, 200, 1000);
		gestures.down(2, 300, 200, 1000);
		gestures.move(1, 150, 150);
		gestures.move(2, 250, 150);
		gestures.up(1, 1200);
		gestures.up(2, 1200);
		expect(sent).toEqual([]);
		expect(gestures.zoom).toEqual({ scale: 2, x: -50, y: -50 });
	});

	it('FA12: a double two-finger tap while zoomed goes back to 1x without a right click', () => {
		const { sent, gestures, elapse } = touches('trackpad');
		zoomToTwo(gestures, 0);
		for (const at of [1000, 1200]) {
			gestures.down(1, 100, 100, at);
			gestures.down(2, 150, 100, at);
			gestures.up(1, at + 60);
			gestures.up(2, at + 60);
		}
		elapse();
		expect(gestures.zoom).toEqual({ scale: 1, x: 0, y: 0 });
		expect(sent).toEqual([]);
	});

	it('FA12: a single two-finger tap while zoomed still right-clicks, a moment later', () => {
		const { sent, gestures, elapse } = touches('trackpad');
		zoomToTwo(gestures, 0);
		gestures.down(1, 100, 100, 1000);
		gestures.down(2, 150, 100, 1000);
		gestures.up(1, 1060);
		gestures.up(2, 1060);
		expect(sent).toEqual([]);
		elapse();
		expect(sent).toEqual(['pointer 800,600 2', 'pointer 800,600 0']);
		expect(gestures.zoom.scale).toBe(2);
	});

	it('FA13: zoomed, a tap in touch mode clicks the display pixel under the finger', () => {
		const { sent, gestures } = touches('touch');
		zoomToTwo(gestures, 0);
		sent.length = 0;
		// At 2x from the corner, page (200,150) shows picture box point (100,75): display (400,300).
		gestures.down(1, 200, 150, 1000);
		gestures.up(1, 1050);
		expect(sent).toEqual(['pointer 400,300 0', 'pointer 400,300 1', 'pointer 400,300 0']);
	});

	it('FA13: zoomed, the trackpad moves the pointer by the finger over the enlarged picture', () => {
		const { sent, gestures } = touches('trackpad');
		zoomToTwo(gestures, 0);
		gestures.position = { x: 400, y: 300 };
		gestures.down(1, 100, 100, 1000);
		gestures.move(1, 120, 100);
		gestures.up(1, 1100);
		// Two display pixels per page pixel at 2x, not four.
		expect(sent).toEqual(['pointer 440,300 0']);
	});

	it('the finger left down after a two-finger gesture does nothing', () => {
		const { sent, gestures } = touches('trackpad');
		gestures.down(1, 0, 0, 0);
		gestures.down(2, 100, 0, 0);
		gestures.move(2, 200, 0);
		gestures.up(2, 100);
		gestures.move(1, 50, 50);
		gestures.up(1, 200);
		expect(sent).toEqual([]);
	});
});
