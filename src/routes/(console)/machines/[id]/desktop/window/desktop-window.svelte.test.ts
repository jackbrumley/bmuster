import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import type { Grant } from '#lib/domain/access/access.ts';
import { FakeSocket } from '#tests/helpers/fake-socket.ts';
import { TEST_MACHINE } from '#tests/helpers/machines.ts';
import '#lib/ui/design-tokens.css';
import DesktopWindow from './+page@.svelte';

// SPEC-DESKTOP-POPOUT PO6, PO7: the desktop popped out into a window of its own.

const SESSION = '55555555-5555-4555-8555-555555555555';
const GRANTS: Grant[] = [
	{ permission: 'view', consent: 'unattended' },
	{ permission: 'desktop-view', consent: 'unattended' },
	{ permission: 'desktop-control', consent: 'unattended' }
];

const asked: string[] = [];
let address = '';

beforeEach(async () => {
	await page.viewport(900, 600);
	sessionStorage.clear();
	asked.length = 0;
	FakeSocket.last = undefined;
	vi.stubGlobal('WebSocket', FakeSocket);
	vi.stubGlobal(
		'fetch',
		vi.fn((url: string) => {
			asked.push(url);
			return Promise.resolve(Response.json({ kind: 'issued', browserTicket: 'moved-here' }));
		})
	);
	// The tab opened this window with its running session in the address.
	address = window.location.href;
	history.replaceState(
		history.state,
		'',
		`${window.location.pathname}?sessionId=${SESSION}&mode=control&since=1794000000000`
	);
});

afterEach(() => {
	history.replaceState(history.state, '', address);
	sessionStorage.clear();
});

/** Opens the window page and plays the server's side of joining the handed-over session. */
async function openWindow() {
	const screen = await render(DesktopWindow, {
		form: undefined,
		params: { id: TEST_MACHINE.id },
		data: { signedIn: true, machine: TEST_MACHINE, grants: GRANTS }
	});
	await expect.poll(() => FakeSocket.last?.url ?? '').toContain('ticket=moved-here');
	const socket = FakeSocket.last;
	if (socket === undefined) throw new Error('the window opened no socket');
	socket.receive(JSON.stringify({ type: 'attached', resumed: true }));
	socket.receive(JSON.stringify({ type: 'ready' }));
	return { screen, socket };
}

describe('the pop-out window', () => {
	it('PO6: joins the handed-over session in a bare window titled with the machine name', async () => {
		const { screen } = await openWindow();
		expect(asked).toEqual([`/api/sessions/${SESSION}/browser-ticket`]);
		expect(document.title).toBe(TEST_MACHINE.name);
		const stage = screen.getByRole('application', { name: `Screen of ${TEST_MACHINE.name}` });
		await expect.element(stage).toBeVisible();
		// No console around it: no navigation, machine header or tabs.
		expect(screen.container.querySelector('nav, header, aside')).toBeNull();
		expect(screen.container.textContent).not.toContain('Machines');
		// The picture fills the window.
		const box = stage.element().getBoundingClientRect();
		expect([Math.round(box.width), Math.round(box.height)]).toEqual([900, 600]);
		// A reload comes back to the same session.
		expect(sessionStorage.getItem(`bmuster.desktop.${TEST_MACHINE.id}`)).toContain(SESSION);
	});

	it('PO7: has the floating controls with Close window, and keys go to the machine, Escape too', async () => {
		const close = vi.fn();
		vi.stubGlobal('close', close);
		const { screen, socket } = await openWindow();
		const stage = screen.getByRole('application', { name: `Screen of ${TEST_MACHINE.name}` });
		await expect.poll(() => document.activeElement).toBe(stage.element());
		await userEvent.keyboard('{Escape}');
		await expect
			.poll(() => socket.messages())
			.toContainEqual(expect.objectContaining({ type: 'key', code: 'Escape', down: true }));
		expect(close).not.toHaveBeenCalled();

		await screen.getByRole('button', { name: 'Session controls' }).click();
		const sheet = screen.getByRole('group', { name: 'Session options' });
		await sheet.getByRole('tab', { name: 'Session' }).click();
		await expect
			.element(sheet.getByRole('button', { name: 'Leave full screen' }))
			.not.toBeInTheDocument();
		await sheet.getByRole('button', { name: 'Close window' }).click();
		expect(close).toHaveBeenCalledTimes(1);
	});

	it('PO6: without a session to join it offers Connect and Watch only', async () => {
		history.replaceState(history.state, '', window.location.pathname);
		const screen = await render(DesktopWindow, {
			form: undefined,
			params: { id: TEST_MACHINE.id },
			data: { signedIn: true, machine: TEST_MACHINE, grants: GRANTS }
		});
		await expect.element(screen.getByRole('button', { name: 'Connect' })).toBeVisible();
		await expect.element(screen.getByRole('button', { name: 'Watch only' })).toBeVisible();
		expect(asked).toEqual([]);
	});
});
