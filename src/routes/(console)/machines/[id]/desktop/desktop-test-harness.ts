import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import { expect, vi } from 'vitest';
import type { Grant } from '#lib/domain/access/access.ts';
import { FakeSocket } from '#tests/helpers/fake-socket.ts';
import { TEST_MACHINE } from '#tests/helpers/machines.ts';
import { presenceOf, underMachineLayout } from '#tests/helpers/machine-presence.ts';
import DesktopTab from './+page.svelte';

/**
 * The desktop tab under test: a fake server that opens every session, the
 * agent's frames, and the tab rendered under the machine layout. Shared by
 * the tab's tests and the local cursor's (SPEC-DESKTOP 22).
 */

export const SESSION = '33333333-3333-4333-8333-333333333333';

export const CONTROL: Grant[] = [
	{ permission: 'view', consent: 'unattended' },
	{ permission: 'desktop-view', consent: 'unattended' },
	{ permission: 'desktop-control', consent: 'unattended' }
];

/** The bodies the tab posted, newest last. */
export const posted: unknown[] = [];

/** Before each test: a desktop-sized page, no saved session, and a server that opens sessions. */
export async function stubDesktopServer(): Promise<void> {
	await page.viewport(1280, 900);
	sessionStorage.clear();
	localStorage.removeItem('bmuster.desktop.touchInput');
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
}

/** The type of every message the tab sent on this socket, oldest first. */
export function sentTypes(socket: FakeSocket): string[] {
	return socket
		.messages()
		.map((message) =>
			typeof message === 'object' && message !== null && 'type' in message
				? String(message.type)
				: '?'
		);
}

/** A tile batch of solid 64x64 tiles, as the agent writes it (SPEC-DESKTOP 4.2). */
export function batch(
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

export const DISPLAYS = {
	type: 'displays',
	list: [
		{ id: 'Xvfb-0', name: 'Screen', x: 0, y: 0, width: 256, height: 128, scale: 1, primary: true }
	],
	current: 'Xvfb-0'
};

export function renderTab(grants: Grant[], machine = TEST_MACHINE) {
	const now = Date.parse('2026-11-07T12:00:00.000Z');
	return render(
		DesktopTab,
		{
			params: { id: machine.id },
			data: {
				user: { id: 'a', name: 'Ada', email: 'ada@example.com', role: 'admin' as const },
				localNetworkMode: false,
				serverUpdate: null,
				runCommands: false,
				assistant: { kind: 'none' },
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
export function attach(socket: FakeSocket): void {
	socket.receive(JSON.stringify({ type: 'attached', resumed: false }));
	socket.receive(JSON.stringify({ type: 'ready' }));
	socket.receive(JSON.stringify(DISPLAYS));
}

export async function open(
	grants: Grant[],
	button: 'Connect' | 'Watch only',
	machine = TEST_MACHINE
) {
	const screen = await renderTab(grants, machine);
	await screen.getByRole('button', { name: button }).click();
	await expect.poll(() => FakeSocket.last?.url ?? '').toContain('ticket=t-1');
	const socket = FakeSocket.last;
	if (socket === undefined) throw new Error('no socket');
	attach(socket);
	return { screen, socket };
}
