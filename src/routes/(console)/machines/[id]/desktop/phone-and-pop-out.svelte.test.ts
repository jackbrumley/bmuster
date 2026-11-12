import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import type { Grant } from '#lib/domain/access/access.ts';
import { toasts } from '#lib/ui/toast.svelte.ts';
import { FakeSocket } from '#tests/helpers/fake-socket.ts';
import { presenceOf, underMachineLayout } from '#tests/helpers/machine-presence.ts';
import { TEST_MACHINE } from '#tests/helpers/machines.ts';
import '#lib/ui/design-tokens.css';
import DesktopTab from './+page.svelte';

// SPEC-DESKTOP-POPOUT PF1–PF4 (phones open in full screen) and PO2–PO5 (Pop out).

const SESSION = '44444444-4444-4444-8444-444444444444';
const MAY_CONTROL: Grant[] = (['view', 'desktop-view', 'desktop-control'] as const).map(
	(permission) => ({ permission, consent: 'unattended' })
);
const BOTH_SCREENS = JSON.stringify({
	type: 'displays',
	list: [
		{ id: 'A', name: 'Left', x: 0, y: 0, width: 200, height: 100, scale: 1, primary: true },
		{ id: 'B', name: 'Right', x: 200, y: 0, width: 200, height: 100, scale: 1, primary: false }
	],
	current: 'A'
});

/** Requests the page made, by address. */
const requests: string[] = [];

beforeEach(async () => {
	await page.viewport(1280, 900);
	sessionStorage.clear();
	requests.length = 0;
	toasts.list = [];
	FakeSocket.last = undefined;
	vi.stubGlobal('WebSocket', FakeSocket);
	vi.stubGlobal(
		'fetch',
		vi.fn((url: string) => {
			requests.push(url);
			return Promise.resolve(
				Response.json(
					url.endsWith('/browser-ticket')
						? { kind: 'issued', browserTicket: 'again' }
						: { sessionId: SESSION, browserTicket: 'first' }
				)
			);
		})
	);
});

afterEach(async () => {
	sessionStorage.clear();
	if (document.fullscreenElement !== null) await document.exitFullscreen();
});

/** A phone: every query about a coarse pointer matches. */
function onAPhone(): void {
	const real = window.matchMedia.bind(window);
	vi.stubGlobal('matchMedia', (query: string): MediaQueryList =>
		real(query.includes('pointer: coarse') ? 'all' : query)
	);
}

function socketNow(): FakeSocket {
	const socket = FakeSocket.last;
	if (socket === undefined) throw new Error('the page opened no socket');
	return socket;
}

/** Renders the tab, presses a start button and plays the server's side up to a first picture. */
async function connect(button: 'Connect' | 'Watch only') {
	const loadedAt = Date.parse('2026-11-12T09:00:00.000Z');
	const screen = await render(
		DesktopTab,
		{
			params: { id: TEST_MACHINE.id },
			data: {
				user: { id: 'u', name: 'Uma', email: 'uma@example.com', role: 'member' as const },
				localNetworkMode: false,
				serverUpdate: null,
				signedIn: true,
				now: loadedAt,
				machine: TEST_MACHINE,
				grants: MAY_CONTROL
			}
		},
		underMachineLayout(presenceOf(TEST_MACHINE, loadedAt))
	);
	await screen.getByRole('button', { name: button }).click();
	await expect.poll(() => FakeSocket.last?.url ?? '').toContain('ticket=first');
	const socket = socketNow();
	for (const message of [{ type: 'attached', resumed: false }, { type: 'ready' }]) {
		socket.receive(JSON.stringify(message));
	}
	socket.receive(BOTH_SCREENS);
	const stage = screen.getByRole('application', { name: `Screen of ${TEST_MACHINE.name}` });
	return { screen, socket, stage };
}

/** What `window.open` hands back: a window that can be focused and closed. */
function fakeWindow() {
	return {
		closed: false,
		focus: vi.fn(),
		close: vi.fn(function (this: { closed: boolean }) {
			this.closed = true;
		})
	};
}

describe('phones open the desktop in full screen', () => {
	it('PF1: a phone page has only Full screen and Disconnect around the picture', async () => {
		onAPhone();
		await page.viewport(375, 667);
		const { screen } = await connect('Connect');
		await expect.poll(() => document.fullscreenElement).not.toBeNull();
		await document.exitFullscreen();
		await expect.element(screen.getByRole('button', { name: 'Full screen' })).toBeVisible();
		await expect.element(screen.getByRole('button', { name: 'Disconnect' })).toBeVisible();
		for (const gone of [
			'Keys',
			'Picture settings',
			'Switch to view only',
			'Pop out into a window',
			'Touch input: trackpad. Switch to tapping where to click'
		]) {
			await expect
				.element(screen.getByRole('button', { name: gone, exact: true }))
				.not.toBeInTheDocument();
		}
		await expect.element(screen.getByRole('group', { name: 'Display' })).not.toBeInTheDocument();
		expect(screen.container.querySelector('.phone-keys')).toBeNull();
		expect(screen.container.textContent).not.toContain('Trackpad: drag to move the pointer');

		// Full screen again: the sheet holds the rest.
		await screen.getByRole('button', { name: 'Full screen' }).click();
		await expect.element(screen.getByRole('button', { name: 'Session controls' })).toBeVisible();
	});

	it('PF2: Connect and Watch only go full screen on the stage in the same tap', async () => {
		onAPhone();
		await page.viewport(375, 667);
		const control = await connect('Connect');
		await expect.poll(() => document.fullscreenElement).toBe(control.stage.element());
		await expect
			.element(control.screen.getByRole('button', { name: 'Session controls' }))
			.toBeVisible();
		await document.exitFullscreen();
		await control.screen.unmount();
		sessionStorage.clear();

		const watch = await connect('Watch only');
		await expect.poll(() => document.fullscreenElement).toBe(watch.stage.element());
	});

	it('PF3: a phone that refuses full screen fills the window, with no error', async () => {
		vi.spyOn(HTMLElement.prototype, 'requestFullscreen').mockRejectedValue(
			new TypeError('Fullscreen is not supported')
		);
		onAPhone();
		await page.viewport(375, 667);
		const { screen, stage } = await connect('Connect');
		await expect.poll(() => getComputedStyle(stage.element()).position).toBe('fixed');
		await expect.element(screen.getByRole('button', { name: 'Session controls' })).toBeVisible();
		expect(screen.container.querySelector('[role="alert"]')).toBeNull();
	});

	it('PF4: a computer keeps its bar with Pop out, and Connect stays on the page', async () => {
		const { screen } = await connect('Connect');
		for (const tool of ['Keys', 'Picture settings', 'Full screen', 'Pop out into a window']) {
			await expect.element(screen.getByRole('button', { name: tool, exact: true })).toBeVisible();
		}
		await expect.element(screen.getByRole('group', { name: 'Display' })).toBeVisible();
		expect(document.fullscreenElement).toBeNull();
	});
});

describe('Pop out', () => {
	it('PO2: opens the session in a window named for the machine, and a second click focuses it', async () => {
		const popup = fakeWindow();
		const open = vi.fn(() => popup);
		vi.stubGlobal('open', open);
		const { screen } = await connect('Connect');
		const popOut = screen.getByRole('button', { name: 'Pop out into a window' });
		await expect.element(popOut).toHaveAttribute('title', 'Pop out into a window');
		await popOut.click();

		expect(open).toHaveBeenCalledTimes(1);
		const [url, name, features] = open.mock.calls[0] ?? [];
		const address = new URL(String(url), window.location.origin);
		expect(address.pathname).toBe(`/machines/${TEST_MACHINE.id}/desktop/window`);
		expect(address.searchParams.get('sessionId')).toBe(SESSION);
		expect(address.searchParams.get('mode')).toBe('control');
		expect(Number(address.searchParams.get('since'))).toBeGreaterThan(0);
		expect(name).toBe(`bmuster-desktop-${TEST_MACHINE.id}`);
		// The 200×100 screen keeps its 2:1 shape.
		const size = /^popup,width=(\d+),height=(\d+)$/.exec(String(features));
		expect(size).not.toBeNull();
		expect(Number(size?.[1]) / Number(size?.[2])).toBeCloseTo(2, 1);

		await popOut.click();
		expect(open).toHaveBeenCalledTimes(1);
		expect(popup.focus).toHaveBeenCalledTimes(1);
	});

	it('PO3: once the window has the session the tab hides the picture and offers it back', async () => {
		const popup = fakeWindow();
		vi.stubGlobal('open', () => popup);
		const { screen, socket, stage } = await connect('Connect');
		const picture = stage.element();
		await screen.getByRole('button', { name: 'Pop out into a window' }).click();
		socket.closedByServer(4001);

		const moved = screen.getByRole('status').filter({ hasText: 'Open in a separate window' });
		await expect.element(moved).toBeVisible();
		expect(getComputedStyle(picture).display).toBe('none');
		expect(screen.container.textContent).not.toContain('Use it here');
		await moved.getByRole('button', { name: 'Bring it back' }).click();
		expect(popup.focus).toHaveBeenCalledTimes(1);
		expect(FakeSocket.last).toBe(socket);
	});

	it('PO4: when the window is closed Bring it back resumes the session in the tab', async () => {
		const popup = fakeWindow();
		vi.stubGlobal('open', () => popup);
		const { screen, socket, stage } = await connect('Connect');
		await screen.getByRole('button', { name: 'Pop out into a window' }).click();
		socket.closedByServer(4001);
		popup.closed = true;

		await expect.element(screen.getByText('The separate window was closed')).toBeVisible();
		await screen.getByRole('button', { name: 'Bring it back' }).click();
		await expect.poll(() => FakeSocket.last?.url ?? '').toContain('ticket=again');
		expect(requests).toContain(`/api/sessions/${SESSION}/browser-ticket`);
		socketNow().receive(JSON.stringify({ type: 'attached', resumed: true }));
		await expect.element(stage).toBeVisible();
		await expect
			.element(screen.getByText('The separate window was closed'))
			.not.toBeInTheDocument();
	});

	it('PO4: Close window closes it and takes the session back at once', async () => {
		const popup = fakeWindow();
		vi.stubGlobal('open', () => popup);
		const { screen, socket } = await connect('Connect');
		await screen.getByRole('button', { name: 'Pop out into a window' }).click();
		socket.closedByServer(4001);

		await screen.getByRole('button', { name: 'Close window' }).click();
		expect(popup.close).toHaveBeenCalledTimes(1);
		await expect.poll(() => FakeSocket.last?.url ?? '').toContain('ticket=again');
	});

	it('PO5: a blocked pop-up says so and leaves the session in the tab', async () => {
		vi.stubGlobal('open', () => null);
		const { screen, stage } = await connect('Connect');
		await screen.getByRole('button', { name: 'Pop out into a window' }).click();
		expect(toasts.list.map((toast) => [toast.tone, toast.message])).toEqual([
			['error', 'The browser blocked the new window. Allow pop-ups for BMuster and try again.']
		]);
		await expect.element(stage).toBeVisible();
		await expect.element(screen.getByRole('button', { name: 'Disconnect' })).toBeVisible();
	});
});
