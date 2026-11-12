import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import type { Grant } from '#lib/domain/access/access.ts';
import { confirmation } from '#lib/ui/confirm-action.svelte.ts';
import { FakeSocket } from '#tests/helpers/fake-socket.ts';
import { TEST_MACHINE } from '#tests/helpers/machines.ts';
import '#lib/ui/design-tokens.css';
import DesktopTab from './+page.svelte';
import { presenceOf, underMachineLayout } from '#tests/helpers/machine-presence.ts';

// SPEC-DESKTOP R1, R3, R4, R5, R7, R10, R17; SPEC-DESKTOP-KEYS K6;
// SPEC-DESKTOP-FLOATING F1, F2, F4, F8, F10, FA13, FA14, FA15;
// SPEC-DESKTOP-ALL-SCREENS A8, A9, A10; SPEC-DESKTOP 20 C8, C12.

const SESSION = '33333333-3333-4333-8333-333333333333';

const CONTROL: Grant[] = [
	{ permission: 'view', consent: 'unattended' },
	{ permission: 'desktop-view', consent: 'unattended' },
	{ permission: 'desktop-control', consent: 'unattended' }
];

const posted: unknown[] = [];

beforeEach(async () => {
	await page.viewport(1280, 900);
	sessionStorage.clear();
	posted.length = 0;
	FakeSocket.last = undefined;
	vi.stubGlobal('WebSocket', FakeSocket);
	vi.stubGlobal(
		'fetch',
		vi.fn((_url: string, init: RequestInit) => {
			posted.push(typeof init.body === 'string' ? JSON.parse(init.body) : undefined);
			return Promise.resolve(Response.json({ sessionId: SESSION, browserTicket: 't-1' }));
		})
	);
});

afterEach(() => {
	sessionStorage.clear();
});

/** A tile batch of solid 64x64 tiles, as the agent writes it (SPEC-DESKTOP 4.2). */
function batch(
	seq: number,
	flags: number,
	tiles: { x: number; y: number; rgb: [number, number, number] }[],
	size: { width: number; height: number } = { width: 128, height: 64 }
): Uint8Array {
	const bytes = new Uint8Array(22 + tiles.length * 17);
	const view = new DataView(bytes.buffer);
	bytes.set([2, 0, flags, 1]);
	view.setUint32(4, seq, true);
	view.setUint16(16, size.width, true);
	view.setUint16(18, size.height, true);
	view.setUint16(20, tiles.length, true);
	tiles.forEach((tile, index) => {
		const at = 22 + index * 17;
		view.setUint16(at, tile.x, true);
		view.setUint16(at + 2, tile.y, true);
		view.setUint16(at + 4, 64, true);
		view.setUint16(at + 6, 64, true);
		bytes[at + 8] = 3;
		view.setUint32(at + 9, 4, true);
		bytes.set([...tile.rgb, 255], at + 13);
	});
	return bytes;
}

const DISPLAYS = {
	type: 'displays',
	list: [
		{ id: 'Xvfb-0', name: 'Screen', x: 0, y: 0, width: 256, height: 128, scale: 1, primary: true }
	],
	current: 'Xvfb-0'
};

/** Two displays side by side, 256x128 and 128x64, from an agent that can show both at once. */
const TWO_DISPLAYS = {
	type: 'displays',
	list: [
		{ id: 'L', name: 'Left', x: 0, y: 0, width: 256, height: 128, scale: 1, primary: true },
		{ id: 'R', name: 'Right', x: 256, y: 0, width: 128, height: 64, scale: 1, primary: false }
	],
	current: 'L',
	allScreens: true
};

function renderTab(grants: Grant[], machine = TEST_MACHINE) {
	const now = Date.parse('2026-11-07T12:00:00.000Z');
	return render(
		DesktopTab,
		{
			params: { id: machine.id },
			data: {
				user: { id: 'a', name: 'Ada', email: 'ada@example.com', role: 'admin' as const },
				localNetworkMode: false,
				serverUpdate: null,
				signedIn: true,
				now,
				machine,
				grants
			}
		},
		underMachineLayout(presenceOf(machine, now))
	);
}

/** The server's side of a socket that just opened: attached, ready, the displays. */
function attach(socket: FakeSocket): void {
	socket.receive(JSON.stringify({ type: 'attached', resumed: false }));
	socket.receive(JSON.stringify({ type: 'ready' }));
	socket.receive(JSON.stringify(DISPLAYS));
}

async function open(grants: Grant[], button: 'Connect' | 'Watch only', machine = TEST_MACHINE) {
	const screen = await renderTab(grants, machine);
	await screen.getByRole('button', { name: button }).click();
	await expect.poll(() => FakeSocket.last?.url ?? '').toContain('ticket=t-1');
	const socket = FakeSocket.last;
	if (socket === undefined) throw new Error('no socket');
	attach(socket);
	return { screen, socket };
}

function sentTypes(socket: FakeSocket): string[] {
	return socket
		.messages()
		.map((message) =>
			typeof message === 'object' && message !== null && 'type' in message
				? String(message.type)
				: '?'
		);
}

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

/** Connects at phone size and goes full screen, with the touch layout. */
async function fullScreenOnPhone() {
	pretendTouchScreen();
	await page.viewport(375, 667);
	const opened = await open(CONTROL, 'Connect');
	opened.socket.receive(batch(1, 1 | 4, [{ x: 0, y: 0, rgb: [1, 2, 3] }]));
	await opened.screen.getByRole('button', { name: 'Full screen' }).click();
	await expect.poll(() => document.fullscreenElement !== null).toBe(true);
	return opened;
}

function canvasPixel(container: HTMLElement, x: number, y: number): number[] {
	const canvas = container.querySelector<HTMLCanvasElement>('canvas.screen');
	const data = canvas?.getContext('2d')?.getImageData(x, y, 1, 1).data;
	return data === undefined ? [] : [...data.slice(0, 3)];
}

describe('the desktop tab', () => {
	it('R2: opens a control session and greets the agent with hello, settings and a keyframe request', async () => {
		const { socket } = await open(CONTROL, 'Connect');
		expect(posted[0]).toEqual({ kind: 'desktop', mode: 'control' });
		const [hello, ...rest] = socket.messages().slice(0, 3);
		expect(hello).toMatchObject({ type: 'hello', codecs: ['jpeg'] });
		expect(rest).toEqual([
			{ type: 'settings', quality: 'auto', scale: 'fit', maxFps: 15 },
			{ type: 'keyframe' }
		]);
	});

	it('L4: waits under the veil while connecting and until the first picture, then lifts it', async () => {
		const screen = await renderTab(CONTROL);
		await screen.getByRole('button', { name: 'Connect' }).click();
		const stage = screen.getByRole('application', { name: `Screen of ${TEST_MACHINE.name}` });
		await expect
			.element(stage.getByRole('status').getByText(`Connecting to ${TEST_MACHINE.name}`))
			.toBeVisible();
		expect(stage.element().getAttribute('aria-busy')).toBe('true');
		expect(stage.element().querySelector('[data-radar="large"]')).not.toBeNull();
		await expect.poll(() => FakeSocket.last?.url ?? '').toContain('ticket=t-1');
		const socket = FakeSocket.last;
		if (socket === undefined) throw new Error('no socket');
		attach(socket);
		await expect
			.element(stage.getByRole('status').getByText('Waiting for the first picture'))
			.toBeVisible();
		socket.receive(batch(1, 1 | 4, [{ x: 0, y: 0, rgb: [200, 10, 10] }]));
		await expect.element(stage.getByText('Waiting for the first picture')).not.toBeInTheDocument();
		expect(stage.element().getAttribute('aria-busy')).toBe('false');
	});

	it('R4, R5: draws a frame from all its batches and acknowledges it only after the last', async () => {
		const { screen, socket } = await open(CONTROL, 'Connect');
		socket.receive(batch(1, 1, [{ x: 0, y: 0, rgb: [200, 10, 10] }]));
		await new Promise((done) => setTimeout(done, 50));
		expect(sentTypes(socket)).not.toContain('ack');
		socket.receive(batch(1, 1 | 4, [{ x: 64, y: 0, rgb: [10, 200, 10] }]));
		await expect.poll(() => socket.messages()).toContainEqual({ type: 'ack', seq: 1 });
		expect(canvasPixel(screen.container, 10, 10)).toEqual([200, 10, 10]);
		expect(canvasPixel(screen.container, 70, 10)).toEqual([10, 200, 10]);
	});

	it('R4: asks for a keyframe after a gap in the frame numbers', async () => {
		const { socket } = await open(CONTROL, 'Connect');
		socket.receive(batch(1, 1 | 4, [{ x: 0, y: 0, rgb: [1, 2, 3] }]));
		await expect.poll(() => socket.messages()).toContainEqual({ type: 'ack', seq: 1 });
		const before = sentTypes(socket).filter((type) => type === 'keyframe').length;
		socket.receive(batch(3, 4, [{ x: 0, y: 0, rgb: [1, 2, 3] }]));
		await expect
			.poll(() => sentTypes(socket).filter((type) => type === 'keyframe').length)
			.toBe(before + 1);
	});

	it('R7: sends clicks in display pixels, keys by position, and releases all on blur', async () => {
		const { screen, socket } = await open(CONTROL, 'Connect');
		socket.receive(batch(1, 1 | 4, [{ x: 0, y: 0, rgb: [1, 2, 3] }]));
		await expect.poll(() => socket.messages()).toContainEqual({ type: 'ack', seq: 1 });
		const stage = screen.getByRole('application', { name: /Screen of/ });
		await stage.click({ position: { x: 5, y: 5 } });
		await userEvent.keyboard('a');
		window.dispatchEvent(new Event('blur'));
		const messages = socket.messages();
		expect(messages).toContainEqual(expect.objectContaining({ type: 'pointer', buttons: 1 }));
		expect(messages).toContainEqual({
			type: 'key',
			code: 'KeyA',
			key: 'a',
			down: true,
			altGr: false
		});
		expect(sentTypes(socket).at(-1)).toBe('release-all');
	});

	it('R3: a watch-only session shows View only and sends no input', async () => {
		const { screen, socket } = await open(CONTROL, 'Watch only');
		expect(posted[0]).toEqual({ kind: 'desktop', mode: 'watch' });
		socket.receive(batch(1, 1 | 4, [{ x: 0, y: 0, rgb: [1, 2, 3] }]));
		await expect.element(screen.getByText('View only')).toBeVisible();
		const stage = screen.getByRole('application', { name: /Screen of/ });
		await stage.click({ position: { x: 5, y: 5 } });
		await userEvent.keyboard('a');
		window.dispatchEvent(new Event('blur'));
		const input = ['pointer', 'wheel', 'key', 'text', 'special', 'release-all'];
		expect(sentTypes(socket).filter((type) => input.includes(type))).toEqual([]);
	});

	it('Wayland approval: clicking Ask for approval shows immediate progress and sends the request', async () => {
		const { screen, socket } = await open(CONTROL, 'Connect');
		socket.receive(
			JSON.stringify({
				type: 'state',
				screen: {
					kind: 'approval',
					phase: 'needed',
					message: 'Allow screen sharing on this computer before connecting'
				}
			})
		);
		await screen.getByRole('button', { name: 'Ask for approval' }).click();
		expect(screen.getByText('Requesting approval on the machine…')).toBeTruthy();
		expect(sentTypes(socket)).toContain('ask-approval');
	});

	it('R10: picture settings go to the agent as one settings message', async () => {
		const { screen, socket } = await open(CONTROL, 'Connect');
		await screen.getByRole('button', { name: 'Picture settings' }).click();
		await screen.getByRole('button', { name: '50%' }).click();
		expect(socket.messages().at(-1)).toEqual({
			type: 'settings',
			quality: 'auto',
			scale: 0.5,
			maxFps: 15
		});
	});

	it('shows what the machine screen shows and stays open while it changes', async () => {
		const { screen, socket } = await open(CONTROL, 'Connect');
		const state = (value: object) => {
			socket.receive(JSON.stringify({ type: 'state', screen: value }));
		};
		state({ kind: 'desktop', user: 'jack' });
		await expect.element(screen.getByText("jack's desktop", { exact: true })).toBeVisible();
		state({ kind: 'locked', user: 'jack' });
		await expect.element(screen.getByText("jack's desktop · locked")).toBeVisible();
		state({ kind: 'sign-in' });
		await expect.element(screen.getByText('Sign-in screen')).toBeVisible();
		socket.receive(JSON.stringify({ type: 'displays', list: [], current: '' }));
		state({ kind: 'unavailable', reason: 'Wayland sign-in screen not supported yet' });
		const reason = 'Screen not available: Wayland sign-in screen not supported yet';
		await expect.element(screen.getByText(reason).first()).toBeVisible();
		await expect.element(screen.getByRole('button', { name: 'Disconnect' })).toBeVisible();
		socket.receive(JSON.stringify(DISPLAYS));
		state({ kind: 'desktop', user: 'jack' });
		await expect.element(screen.getByText(reason).first()).not.toBeInTheDocument();
	});

	it('says why the session ended, as the server tells it', async () => {
		const { screen, socket } = await open(CONTROL, 'Connect');
		socket.receive(
			JSON.stringify({
				type: 'ended',
				reason: 'disconnected-at-machine',
				message: 'Someone at the machine pressed Disconnect.'
			})
		);
		await expect
			.element(screen.getByText('Someone at the machine pressed Disconnect.'))
			.toBeVisible();
		await expect.element(screen.getByRole('button', { name: 'Connect' })).toBeVisible();
		await expect.element(screen.getByRole('button', { name: 'Watch only' })).toBeVisible();
	});

	it('offers both choices again after Watch only and Disconnect, and Connect then controls', async () => {
		const { screen, socket } = await open(CONTROL, 'Watch only');
		await screen.getByRole('button', { name: 'Disconnect' }).click();
		await expect.poll(() => confirmation.current.kind).toBe('asking');
		if (confirmation.current.kind === 'asking') confirmation.current.answer(true);
		await expect.poll(() => socket.messages()).toContainEqual({ type: 'end' });
		socket.receive(
			JSON.stringify({
				type: 'ended',
				reason: 'closed',
				message: 'The session was ended from the console.'
			})
		);
		await expect.element(screen.getByRole('button', { name: 'Watch only' })).toBeVisible();
		await screen.getByRole('button', { name: 'Connect', exact: true }).click();
		await expect.poll(() => posted.at(-1)).toEqual({ kind: 'desktop', mode: 'control' });
	});

	it('keeps the mode when it reattaches after a reload or a dropped connection', async () => {
		sessionStorage.setItem(
			`bmuster.desktop.${TEST_MACHINE.id}`,
			JSON.stringify({ sessionId: SESSION, tag: 'watch', sinceMs: Date.now() })
		);
		vi.stubGlobal(
			'fetch',
			vi.fn((url: string) => {
				posted.push(url);
				return Promise.resolve(Response.json({ kind: 'issued', browserTicket: 't-2' }));
			})
		);
		const screen = await renderTab(CONTROL);
		await expect.poll(() => FakeSocket.last?.url ?? '').toContain('ticket=t-2');
		const first = FakeSocket.last;
		if (first === undefined) throw new Error('no socket');
		attach(first);
		await expect.element(screen.getByText('View only')).toBeVisible();
		expect(screen.container.textContent).not.toContain('Connect');

		first.drop();
		await expect.poll(() => FakeSocket.last !== first, { timeout: 5000 }).toBe(true);
		const second = FakeSocket.last;
		if (second === undefined) throw new Error('no socket');
		attach(second);
		await expect.element(screen.getByText('View only')).toBeVisible();
		expect(screen.container.textContent).not.toContain('Connect');
		expect(posted.every((url) => typeof url === 'string' && url.includes('browser-ticket'))).toBe(
			true
		);
	});

	it('switches a running watch session to control by opening a new one', async () => {
		const { screen, socket } = await open(CONTROL, 'Watch only');
		await screen.getByRole('button', { name: 'Take control' }).click();
		await expect.poll(() => posted.at(-1)).toEqual({ kind: 'desktop', mode: 'control' });
		expect(socket.messages()).toContainEqual({ type: 'end' });
		await expect.poll(() => FakeSocket.last !== socket).toBe(true);
		const next = FakeSocket.last;
		if (next === undefined) throw new Error('no socket');
		attach(next);
		await expect.element(screen.getByRole('button', { name: 'Switch to view only' })).toBeVisible();
		expect(screen.container.textContent).not.toContain('View only');
	});

	it('full screen has a bar with Exit that hides when idle and comes back near the top edge', async () => {
		const { screen, socket } = await open(CONTROL, 'Connect');
		socket.receive(batch(1, 1 | 4, [{ x: 0, y: 0, rgb: [1, 2, 3] }]));
		await screen.getByRole('button', { name: 'Full screen' }).click();
		await expect.poll(() => document.fullscreenElement !== null).toBe(true);
		const bar = screen.getByRole('group', { name: 'Full screen controls' });
		await expect.element(bar).toBeVisible();
		await expect.element(bar.getByText('Control')).toBeVisible();
		await expect.element(bar.getByRole('button', { name: 'Disconnect' })).toBeVisible();

		// The bar's own clicks never reach the machine, and the keyboard goes back to the screen.
		const before = sentTypes(socket).filter((type) => type === 'pointer').length;
		await bar.getByRole('button', { name: 'Picture settings' }).click();
		expect(sentTypes(socket).filter((type) => type === 'pointer').length).toBe(before);
		await expect.element(screen.getByRole('application', { name: /Screen of/ })).toHaveFocus();
		await bar.getByRole('button', { name: 'Picture settings' }).click();

		// The mouse leaves the bar for the middle of the screen: the bar hides after a few seconds.
		const stage = screen.getByRole('application', { name: /Screen of/ });
		const middle = stage.element().getBoundingClientRect();
		await stage.hover({ position: { x: middle.width / 2, y: middle.height / 2 } });
		await expect.element(bar, { timeout: 6000 }).not.toBeInTheDocument();
		await stage.hover({ position: { x: 300, y: 5 } });
		await expect.element(bar).toBeVisible();

		await bar.getByRole('button', { name: 'Leave full screen' }).click();
		await expect.poll(() => document.fullscreenElement).toBeNull();
		await expect.element(screen.getByRole('button', { name: 'Full screen' })).toBeVisible();
	});

	it('K6, R13: the Keys menu sends from the bar, and in full screen Ctrl+Alt+Del on Windows', async () => {
		const windows = { ...TEST_MACHINE, osFamily: 'windows' as const };
		const { screen, socket } = await open(CONTROL, 'Connect', windows);
		socket.receive(batch(1, 1 | 4, [{ x: 0, y: 0, rgb: [1, 2, 3] }]));
		await screen.getByRole('button', { name: 'Keys', exact: true }).click();
		const menu = screen.getByRole('group', { name: 'Keys', exact: true });
		await menu.getByRole('button', { name: /^Alt\+Tab/ }).click();
		expect(socket.messages().slice(-4)).toEqual([
			{ type: 'key', code: 'AltLeft', key: 'Alt', down: true, altGr: false },
			{ type: 'key', code: 'Tab', key: 'Tab', down: true, altGr: false },
			{ type: 'key', code: 'Tab', key: 'Tab', down: false, altGr: false },
			{ type: 'key', code: 'AltLeft', key: 'Alt', down: false, altGr: false }
		]);
		await expect.element(screen.getByRole('application', { name: /Screen of/ })).toHaveFocus();

		// Opening Picture settings closes the menu: one block under the bar at a time.
		await screen.getByRole('button', { name: 'Picture settings' }).click();
		await expect.element(menu).not.toBeInTheDocument();

		await screen.getByRole('button', { name: 'Full screen' }).click();
		await expect.poll(() => document.fullscreenElement !== null).toBe(true);
		const bar = screen.getByRole('group', { name: 'Full screen controls' });
		await bar.getByRole('button', { name: 'Keys', exact: true }).click();
		await screen.getByRole('button', { name: /^Ctrl\+Alt\+Del/ }).click();
		expect(confirmation.current.kind).toBe('none');
		expect(socket.messages()).toContainEqual({ type: 'special', name: 'ctrl-alt-del' });
		await bar.getByRole('button', { name: 'Leave full screen' }).click();
		await expect.poll(() => document.fullscreenElement).toBeNull();
	});

	it('K6: the Keys menu shows on a phone too', async () => {
		await page.viewport(390, 844);
		const { screen } = await open(CONTROL, 'Connect');
		await screen.getByRole('button', { name: 'Keys', exact: true }).click();
		await expect.element(screen.getByRole('group', { name: 'Keys', exact: true })).toBeVisible();
		await expect.element(screen.getByRole('button', { name: 'Super key' })).toBeVisible();
	});

	it('K6: a watch-only session has no Keys button, in the bar or in full screen', async () => {
		const { screen, socket } = await open(CONTROL, 'Watch only');
		socket.receive(batch(1, 1 | 4, [{ x: 0, y: 0, rgb: [1, 2, 3] }]));
		await expect.element(screen.getByText('View only')).toBeVisible();
		await expect
			.element(screen.getByRole('button', { name: 'Keys', exact: true }))
			.not.toBeInTheDocument();
		await screen.getByRole('button', { name: 'Full screen' }).click();
		await expect.poll(() => document.fullscreenElement !== null).toBe(true);
		const bar = screen.getByRole('group', { name: 'Full screen controls' });
		await expect.element(bar).toBeVisible();
		await expect
			.element(bar.getByRole('button', { name: 'Keys', exact: true }))
			.not.toBeInTheDocument();
		await document.exitFullscreen();
	});

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
		pretendTouchScreen();
		await page.viewport(375, 667);
		const { screen, socket } = await open(CONTROL, 'Connect');
		socket.receive(batch(1, 1 | 4, [{ x: 0, y: 0, rgb: [1, 2, 3] }]));
		await expect.poll(() => socket.messages()).toContainEqual({ type: 'ack', seq: 1 });
		await screen.getByRole('button', { name: /^Touch input: trackpad/ }).click();
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

	it('A8: offers All screens only with two or more displays and an agent that can', async () => {
		const { screen, socket } = await open(CONTROL, 'Connect');
		// One display: no picker at all.
		await expect.element(screen.getByRole('group', { name: 'Display' })).not.toBeInTheDocument();
		// Two displays from an agent that says nothing about all screens.
		socket.receive(JSON.stringify({ ...TWO_DISPLAYS, allScreens: undefined }));
		const picker = screen.getByRole('group', { name: 'Display' });
		await expect.element(picker.getByRole('button', { name: 'Left' })).toBeVisible();
		await expect
			.element(picker.getByRole('button', { name: 'All screens' }))
			.not.toBeInTheDocument();
		// The same agent, newer: it can.
		socket.receive(JSON.stringify(TWO_DISPLAYS));
		await expect.element(picker.getByRole('button', { name: 'All screens' })).toBeVisible();
	});

	it('A9, A10: All screens sends select-display all, and pointer positions span the combined picture', async () => {
		const { screen, socket } = await open(CONTROL, 'Connect');
		socket.receive(JSON.stringify(TWO_DISPLAYS));
		await screen
			.getByRole('group', { name: 'Display' })
			.getByRole('button', { name: 'All screens' })
			.click();
		await expect
			.poll(() => socket.messages())
			.toContainEqual({ type: 'select-display', display: 'all' });
		socket.receive(JSON.stringify({ ...TWO_DISPLAYS, current: 'all' }));
		await expect
			.element(screen.getByRole('button', { name: 'All screens' }))
			.toHaveAttribute('aria-pressed', 'true');
		// The agent's combined frame: 384x128, the box around both displays.
		socket.receive(
			batch(1, 1 | 4, [{ x: 320, y: 0, rgb: [9, 9, 9] }], { width: 384, height: 128 })
		);
		await expect.poll(() => socket.messages()).toContainEqual({ type: 'ack', seq: 1 });
		const stage = screen.getByRole('application', { name: /Screen of/ });
		const box = stage.element().getBoundingClientRect();
		// The stage keeps the picture's shape, so a click at 90% across is
		// 90% across the combined desktop: on the right-hand display.
		await stage.click({ position: { x: box.width * 0.9, y: box.height * 0.25 } });
		const pointer = socket
			.messages()
			.find(
				(message): message is { type: 'pointer'; x: number; y: number } =>
					typeof message === 'object' &&
					message !== null &&
					'type' in message &&
					message.type === 'pointer'
			);
		expect(pointer?.x).toBeGreaterThan(340);
		expect(pointer?.x).toBeLessThan(352);
		expect(pointer?.y).toBe(32);
	});

	it('A8: the full-screen bar has the screen picker with All screens', async () => {
		const { screen, socket } = await open(CONTROL, 'Connect');
		socket.receive(JSON.stringify(TWO_DISPLAYS));
		socket.receive(batch(1, 1 | 4, [{ x: 0, y: 0, rgb: [1, 2, 3] }]));
		await screen.getByRole('button', { name: 'Full screen' }).click();
		await expect.poll(() => document.fullscreenElement !== null).toBe(true);
		const picker = screen.getByRole('group', { name: 'Screen' });
		await picker.getByRole('button', { name: 'All screens' }).click();
		await expect
			.poll(() => socket.messages())
			.toContainEqual({ type: 'select-display', display: 'all' });
		await expect.element(screen.getByRole('application', { name: /Screen of/ })).toHaveFocus();
		await screen
			.getByRole('group', { name: 'Full screen controls' })
			.getByRole('button', { name: 'Leave full screen' })
			.click();
		await expect.poll(() => document.fullscreenElement).toBeNull();
	});

	it('C12, C8: the Clipboard button opens the panel, which pulls and shows the reply and errors', async () => {
		const { screen, socket } = await open(CONTROL, 'Connect');
		socket.receive(batch(1, 1 | 4, [{ x: 0, y: 0, rgb: [1, 2, 3] }]));
		await screen.getByRole('button', { name: 'Clipboard', exact: true }).click();
		const panel = screen.getByRole('region', { name: 'Clipboard' });
		await panel.getByRole('button', { name: 'Get from machine' }).click();
		await expect.poll(() => socket.messages()).toContainEqual({ type: 'clipboard-pull' });
		socket.receive(JSON.stringify({ type: 'clipboard', text: 'C:\\Windows\\System32' }));
		await expect
			.element(panel.getByRole('textbox', { name: 'Text' }))
			.toHaveValue('C:\\Windows\\System32');

		await panel.getByRole('button', { name: 'Send to machine' }).click();
		await expect
			.poll(() => socket.messages())
			.toContainEqual({ type: 'clipboard-push', text: 'C:\\Windows\\System32' });
		socket.receive(
			JSON.stringify({
				type: 'error',
				code: 'clipboard-failed',
				message: 'Copy and paste is not available on this screen.'
			})
		);
		await expect
			.element(panel.getByRole('alert'))
			.toHaveTextContent('Copy and paste is not available on this screen.');
	});

	it('C12: a watch-only session has no Clipboard button', async () => {
		const { screen, socket } = await open(CONTROL, 'Watch only');
		socket.receive(batch(1, 1 | 4, [{ x: 0, y: 0, rgb: [1, 2, 3] }]));
		await expect.element(screen.getByText('View only')).toBeVisible();
		await expect
			.element(screen.getByRole('button', { name: 'Clipboard', exact: true }))
			.not.toBeInTheDocument();
	});

	it('does not offer a session whose rules ask the person at the screen first', async () => {
		const screen = await render(
			DesktopTab,
			{
				params: { id: TEST_MACHINE.id },
				data: {
					user: { id: 'p', name: 'Pat', email: 'pat@example.com', role: 'member' as const },
					localNetworkMode: false,
					serverUpdate: null,
					signedIn: true,
					now: Date.parse('2026-11-07T12:00:00.000Z'),
					machine: TEST_MACHINE,
					grants: [
						{ permission: 'view', consent: 'ask' },
						{ permission: 'desktop-view', consent: 'ask' }
					]
				}
			},
			underMachineLayout(presenceOf(TEST_MACHINE, Date.parse('2026-11-07T12:00:00.000Z')))
		);
		await expect.element(screen.getByText(/asks the person at the screen first/)).toBeVisible();
		expect(screen.container.querySelector('button')?.textContent ?? '').not.toContain('Watch');
	});
});
