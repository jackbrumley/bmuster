import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { confirmation } from '#lib/ui/confirm-action.svelte.ts';
import '#lib/ui/design-tokens.css';
import { batch, CONTROL, open, sentTypes, stubDesktopServer } from './desktop-test-harness.ts';

// The desktop tab in full screen and on touch screens: SPEC-DESKTOP Q1;
// SPEC-DESKTOP-FLOATING F1, F2, F4, F8, F10, FA13, FA14, FA15, FA20, FA21, FA22.
// The rest of the tab's tests are in desktop.svelte.test.ts.

beforeEach(stubDesktopServer);

afterEach(() => {
	sessionStorage.clear();
});
/**
 * A phone or tablet: the touch-layout media query matches. In full screen
 * the test frame grows to the whole headless screen, so a narrow viewport
 * alone cannot stand in for a phone there.
 */
function pretendTouchScreen(): void {
	const real = window.matchMedia.bind(window);
	// Any query that always matches stands in for the touch-layout one.
	vi.stubGlobal('matchMedia', (query: string): MediaQueryList =>
		real(query.includes('pointer: coarse') ? '(min-width: 0px)' : query)
	);
}

/** Connects at phone size, which goes full screen at once (SPEC-DESKTOP-POPOUT PF2), with the touch layout. */
async function fullScreenOnPhone() {
	pretendTouchScreen();
	await page.viewport(375, 667);
	const opened = await open(CONTROL, 'Connect');
	opened.socket.receive(batch(1, 1 | 4, [{ x: 0, y: 0, rgb: [1, 2, 3] }]));
	await expect.poll(() => document.fullscreenElement !== null).toBe(true);
	return opened;
}

describe('the desktop tab', () => {
	it('follows the browser leaving full screen by itself (Esc)', async () => {
		const { screen } = await open(CONTROL, 'Connect');
		await screen.getByRole('button', { name: 'Full screen' }).click();
		await expect.poll(() => document.fullscreenElement !== null).toBe(true);
		await document.exitFullscreen();
		await expect.element(screen.getByRole('button', { name: 'Full screen' })).toBeVisible();
		await expect
			.element(screen.getByRole('group', { name: 'Full screen controls' }))
			.not.toBeInTheDocument();
	});

	it('F1: full screen on a phone or tablet shows the controls button instead of the bar', async () => {
		const { screen } = await fullScreenOnPhone();
		await expect.element(screen.getByRole('button', { name: 'Session controls' })).toBeVisible();
		await expect
			.element(screen.getByRole('group', { name: 'Full screen controls' }))
			.not.toBeInTheDocument();
		await document.exitFullscreen();
		await expect.poll(() => document.fullscreenElement).toBeNull();
		await expect
			.element(screen.getByRole('button', { name: 'Session controls' }))
			.not.toBeInTheDocument();
	});

	it('F1: full screen on a desktop computer keeps the bar and has no controls button', async () => {
		const { screen, socket } = await open(CONTROL, 'Connect');
		socket.receive(batch(1, 1 | 4, [{ x: 0, y: 0, rgb: [1, 2, 3] }]));
		await screen.getByRole('button', { name: 'Full screen' }).click();
		await expect.poll(() => document.fullscreenElement !== null).toBe(true);
		await expect.element(screen.getByRole('group', { name: 'Full screen controls' })).toBeVisible();
		await expect
			.element(screen.getByRole('button', { name: 'Session controls' }))
			.not.toBeInTheDocument();
		await document.exitFullscreen();
	});

	it('F2, F4: dragging the button or tapping outside its sheet sends nothing to the machine', async () => {
		const { screen, socket } = await fullScreenOnPhone();
		const input = ['pointer', 'wheel', 'key', 'text', 'special'];
		const inputSent = () => sentTypes(socket).filter((type) => input.includes(type)).length;
		const before = inputSent();

		const fab = screen.getByRole('button', { name: 'Session controls' }).element();
		const stage = screen.getByRole('application', { name: /Screen of/ }).element();
		const at = fab.getBoundingClientRect();
		const event = (target: Element, type: string, x: number, y: number, kind: string) => {
			target.dispatchEvent(
				new PointerEvent(type, {
					pointerId: 3,
					pointerType: kind,
					button: 0,
					buttons: type === 'pointerup' ? 0 : 1,
					clientX: x,
					clientY: y,
					bubbles: true,
					cancelable: true
				})
			);
		};
		// A mouse drag that leaves the button and crosses the screen.
		event(fab, 'pointerdown', at.left + 24, at.top + 24, 'mouse');
		event(stage, 'pointermove', 150, 200, 'mouse');
		event(stage, 'pointermove', 60, 300, 'mouse');
		event(stage, 'pointerup', 60, 300, 'mouse');
		await new Promise((done) => setTimeout(done, 50));
		expect(inputSent()).toBe(before);
		await expect
			.poll(() => fab.getBoundingClientRect().left)
			.toBeLessThan(stage.getBoundingClientRect().width / 2);

		await screen.getByRole('button', { name: 'Session controls' }).click();
		// Top right: clear of a bottom sheet and of a side panel on the button's (left) side.
		await screen
			.getByRole('button', { name: 'Close the controls' })
			.click({ position: { x: stage.getBoundingClientRect().width - 30, y: 30 } });
		await expect
			.element(screen.getByRole('group', { name: 'Session options' }))
			.not.toBeInTheDocument();
		await new Promise((done) => setTimeout(done, 50));
		expect(inputSent()).toBe(before);
		await document.exitFullscreen();
	});

	it('Q1: Quality changed in the full-screen sheet goes to the agent at once, in full screen', async () => {
		const { screen, socket } = await fullScreenOnPhone();
		await screen.getByRole('button', { name: 'Session controls' }).click();
		const sheet = screen.getByRole('group', { name: 'Session options' });
		await sheet.getByRole('tab', { name: 'Picture' }).click();
		await sheet.getByRole('button', { name: 'High', exact: true }).click();
		await expect
			.poll(() => socket.messages().at(-1))
			.toEqual({ type: 'settings', quality: 'high', scale: 'fit', maxFps: 15, autoStart: 'high' });
		expect(document.fullscreenElement).not.toBeNull();
		await document.exitFullscreen();
	});

	it('F8: Disconnect in the sheet asks first; Leave full screen leaves it', async () => {
		const { screen, socket } = await fullScreenOnPhone();
		const fab = screen.getByRole('button', { name: 'Session controls' });
		const sheet = screen.getByRole('group', { name: 'Session options' });

		await fab.click();
		await sheet.getByRole('tab', { name: 'Session' }).click();
		await sheet.getByRole('button', { name: 'Leave full screen' }).click();
		await expect.poll(() => document.fullscreenElement).toBeNull();
		await expect.element(fab).not.toBeInTheDocument();

		await screen.getByRole('button', { name: 'Full screen' }).click();
		await expect.poll(() => document.fullscreenElement !== null).toBe(true);
		await fab.click();
		await sheet.getByRole('tab', { name: 'Session' }).click();
		await sheet.getByRole('button', { name: 'Disconnect' }).click();
		await expect.poll(() => confirmation.current.kind).toBe('asking');
		expect(socket.messages()).not.toContainEqual({ type: 'end' });
		if (confirmation.current.kind === 'asking') confirmation.current.answer(true);
		await expect.poll(() => socket.messages()).toContainEqual({ type: 'end' });
		if (document.fullscreenElement !== null) await document.exitFullscreen();
	});

	it('F10: without the browser full screen (iPhone), Full screen fills the window and Leave restores the page', async () => {
		vi.spyOn(Document.prototype, 'fullscreenEnabled', 'get').mockReturnValue(false);
		const request = vi.spyOn(HTMLElement.prototype, 'requestFullscreen');
		await page.viewport(375, 667);
		const { screen, socket } = await open(CONTROL, 'Connect');
		socket.receive(batch(1, 1 | 4, [{ x: 0, y: 0, rgb: [1, 2, 3] }]));
		const stage = screen.getByRole('application', { name: /Screen of/ }).element();

		await screen.getByRole('button', { name: 'Full screen' }).click();
		const fab = screen.getByRole('button', { name: 'Session controls' });
		await expect.element(fab).toBeVisible();
		expect(request).not.toHaveBeenCalled();
		expect(document.fullscreenElement).toBeNull();
		expect(getComputedStyle(stage).position).toBe('fixed');
		const box = stage.getBoundingClientRect();
		expect([box.left, box.top, box.width, box.height]).toEqual([0, 0, 375, 667]);
		expect(document.body.style.overflow).toBe('hidden');
		await expect
			.element(screen.getByRole('group', { name: 'Full screen controls' }))
			.not.toBeInTheDocument();

		await fab.click();
		const sheet = screen.getByRole('group', { name: 'Session options' });
		await sheet.getByRole('tab', { name: 'Session' }).click();
		await sheet.getByRole('button', { name: 'Leave full screen' }).click();
		await expect.element(fab).not.toBeInTheDocument();
		expect(getComputedStyle(stage).position).toBe('relative');
		expect(document.body.style.overflow).toBe('');
		await expect.element(screen.getByRole('button', { name: 'Full screen' })).toBeVisible();
	});

	it('F10: a browser that refuses full screen fills the window instead', async () => {
		vi.spyOn(HTMLElement.prototype, 'requestFullscreen').mockRejectedValue(
			new TypeError('Fullscreen is not supported')
		);
		await page.viewport(375, 667);
		const { screen, socket } = await open(CONTROL, 'Connect');
		socket.receive(batch(1, 1 | 4, [{ x: 0, y: 0, rgb: [1, 2, 3] }]));
		await screen.getByRole('button', { name: 'Full screen' }).click();
		await expect.element(screen.getByRole('button', { name: 'Session controls' })).toBeVisible();
		const stage = screen.getByRole('application', { name: /Screen of/ }).element();
		expect(getComputedStyle(stage).position).toBe('fixed');
	});

	/** A touch on the screen element, as a phone's browser reports it. */
	function touch(stage: Element, type: string, id: number, x: number, y: number): void {
		stage.dispatchEvent(
			new PointerEvent(type, {
				pointerId: id,
				pointerType: 'touch',
				clientX: x,
				clientY: y,
				bubbles: true,
				cancelable: true
			})
		);
	}

	it('FA13: a pinch enlarges the picture, and a tap then clicks the display pixel under the finger', async () => {
		// Touch events on a narrow page with the bar (a phone now opens straight into full screen).
		await page.viewport(375, 667);
		const { screen, socket } = await open(CONTROL, 'Connect');
		socket.receive(batch(1, 1 | 4, [{ x: 0, y: 0, rgb: [1, 2, 3] }]));
		await expect.poll(() => socket.messages()).toContainEqual({ type: 'ack', seq: 1 });
		await screen
			.getByRole('group', { name: 'Touch input' })
			.getByRole('button', { name: 'Tap to click' })
			.click();
		const stage = screen.getByRole('application', { name: /Screen of/ }).element();
		const { left, top } = stage.getBoundingClientRect();

		// Two fingers 100 apart spread to 200: 2x about their midpoint, (60,10) inside the stage.
		touch(stage, 'pointerdown', 1, left + 10, top + 10);
		touch(stage, 'pointerdown', 2, left + 110, top + 10);
		touch(stage, 'pointermove', 2, left + 210, top + 10);
		touch(stage, 'pointerup', 1, left + 10, top + 10);
		touch(stage, 'pointerup', 2, left + 210, top + 10);
		const canvas = screen.container.querySelector<HTMLCanvasElement>('canvas.screen');
		await expect.poll(() => canvas?.style.transform).toBe('translate(-10px, -10px) scale(2)');
		const before = socket.messages().length;

		// The stage shows a 256x128 display; zoomed, (100,50) is 110/750 across and 60/375 down.
		touch(stage, 'pointerdown', 3, left + 100, top + 50);
		touch(stage, 'pointerup', 3, left + 100, top + 50);
		await expect
			.poll(() => socket.messages().slice(before))
			.toEqual([
				{ type: 'pointer', x: 38, y: 20, buttons: 0 },
				{ type: 'pointer', x: 38, y: 20, buttons: 1 },
				{ type: 'pointer', x: 38, y: 20, buttons: 0 }
			]);
	});

	it('FA14: a touch device shows the gestures hint once; Got it puts it away for good', async () => {
		localStorage.removeItem('bmuster.desktop.gestureHint');
		pretendTouchScreen();
		await page.viewport(375, 667);
		const first = await open(CONTROL, 'Connect');
		const hint = first.screen.getByRole('region', { name: 'Touch gestures' });
		await expect.element(hint).toBeVisible();
		await expect.element(hint.getByText('Long press')).toBeVisible();
		await hint.getByRole('button', { name: 'Got it' }).click();
		await expect.element(hint).not.toBeInTheDocument();
		await first.screen.unmount();

		const again = await open(CONTROL, 'Connect');
		await expect
			.element(again.screen.getByRole('application', { name: /Screen of/ }))
			.toBeVisible();
		await expect
			.element(again.screen.getByRole('region', { name: 'Touch gestures' }))
			.not.toBeInTheDocument();
		localStorage.removeItem('bmuster.desktop.gestureHint');
	});

	it('FA20, FA21, FA22: one touch input choice in the sheet (phones show none on the page), remembered, with the centre marked for the fixed cursor', async () => {
		const { screen } = await fullScreenOnPhone();
		const names = ['Trackpad', 'Tap to click', 'Fixed cursor'];
		const mark = () => screen.container.querySelector('.centre-mark');
		const openSession = async () => {
			await screen.getByRole('button', { name: 'Session controls' }).click();
			const sheet = screen.getByRole('group', { name: 'Session options' });
			await sheet.getByRole('tab', { name: 'Session' }).click();
			return sheet;
		};
		let sheet = await openSession();
		let inSheet = sheet.getByRole('group', { name: 'Touch input' });
		await expect
			.poll(() =>
				inSheet
					.getByRole('button')
					.elements()
					.map((button) => button.textContent.trim())
			)
			.toEqual(names);
		await expect
			.element(inSheet.getByRole('button', { name: 'Trackpad' }))
			.toHaveAttribute('aria-pressed', 'true');
		// The session's mode is its own badge, apart from the touch input.
		await expect.element(sheet.getByText('Control', { exact: true })).toBeVisible();
		expect(mark()).toBeNull();
		await inSheet.getByRole('button', { name: 'Fixed cursor' }).click();
		expect(localStorage.getItem('bmuster.desktop.touchInput')).toBe('fixed');
		await expect.poll(mark).not.toBeNull();

		// Out of full screen a phone shows only Full screen and Disconnect (PF2).
		await document.exitFullscreen();
		await expect.poll(() => document.fullscreenElement).toBeNull();
		await expect
			.element(screen.getByRole('group', { name: 'Touch input' }))
			.not.toBeInTheDocument();

		await screen.getByRole('button', { name: 'Full screen' }).click();
		await expect.poll(() => document.fullscreenElement !== null).toBe(true);
		sheet = await openSession();
		inSheet = sheet.getByRole('group', { name: 'Touch input' });
		await expect
			.element(inSheet.getByRole('button', { name: 'Fixed cursor' }))
			.toHaveAttribute('aria-pressed', 'true');
		await inSheet.getByRole('button', { name: 'Trackpad' }).click();
		expect(localStorage.getItem('bmuster.desktop.touchInput')).toBe('trackpad');
		await expect.poll(mark).toBeNull();
		await document.exitFullscreen();
	});

	it('FA21: a choice remembered from before is the one in use next time', async () => {
		localStorage.setItem('bmuster.desktop.touchInput', 'touch');
		const { screen } = await open(CONTROL, 'Connect');
		await expect
			.element(
				screen
					.getByRole('group', { name: 'Touch input' })
					.getByRole('button', { name: 'Tap to click' })
			)
			.toHaveAttribute('aria-pressed', 'true');
	});

	it('FA15: a desktop with a mouse sees no gestures hint and draws the picture unzoomed', async () => {
		localStorage.removeItem('bmuster.desktop.gestureHint');
		const { screen, socket } = await open(CONTROL, 'Connect');
		socket.receive(batch(1, 1 | 4, [{ x: 0, y: 0, rgb: [1, 2, 3] }]));
		await expect.poll(() => socket.messages()).toContainEqual({ type: 'ack', seq: 1 });
		await expect
			.element(screen.getByRole('region', { name: 'Touch gestures' }))
			.not.toBeInTheDocument();
		const canvas = screen.container.querySelector<HTMLCanvasElement>('canvas.screen');
		expect(canvas?.style.transform).toBe('');
		// A click maps straight onto the 256x128 display the picture fills, as before.
		const stage = screen.getByRole('application', { name: /Screen of/ });
		const box = stage.element().getBoundingClientRect();
		await stage.click({ position: { x: 40, y: 20 } });
		await expect
			.poll(() => socket.messages())
			.toContainEqual({
				type: 'pointer',
				x: Math.round((40 / box.width) * 256),
				y: Math.round((20 / box.height) * 128),
				buttons: 1
			});
	});
});
