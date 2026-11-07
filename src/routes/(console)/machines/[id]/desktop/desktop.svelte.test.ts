import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import type { Grant } from '#lib/domain/access/access.ts';
import { FakeSocket } from '#tests/helpers/fake-socket.ts';
import { TEST_MACHINE } from '#tests/helpers/machines.ts';
import DesktopTab from './+page.svelte';

// SPEC-DESKTOP R1, R3, R4, R5, R7, R10, R17.

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
	tiles: { x: number; y: number; rgb: [number, number, number] }[]
): Uint8Array {
	const bytes = new Uint8Array(22 + tiles.length * 17);
	const view = new DataView(bytes.buffer);
	bytes.set([2, 0, flags, 1]);
	view.setUint32(4, seq, true);
	view.setUint16(16, 128, true);
	view.setUint16(18, 64, true);
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

async function open(grants: Grant[], button: 'Connect' | 'Watch only') {
	const screen = await render(DesktopTab, {
		params: { id: TEST_MACHINE.id },
		data: {
			user: { id: 'a', name: 'Ada', email: 'ada@example.com', role: 'admin' as const },
			localNetworkMode: false,
			now: Date.parse('2026-11-07T12:00:00.000Z'),
			machine: TEST_MACHINE,
			grants
		}
	});
	await screen.getByRole('button', { name: button }).click();
	await expect.poll(() => FakeSocket.last?.url ?? '').toContain('ticket=t-1');
	const socket = FakeSocket.last;
	if (socket === undefined) throw new Error('no socket');
	socket.receive(JSON.stringify({ type: 'attached', resumed: false }));
	socket.receive(JSON.stringify({ type: 'ready' }));
	socket.receive(JSON.stringify(DISPLAYS));
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
		await expect.element(screen.getByRole('button', { name: 'Connect again' })).toBeVisible();
	});

	it('does not offer a session whose rules ask the person at the screen first', async () => {
		const screen = await render(DesktopTab, {
			params: { id: TEST_MACHINE.id },
			data: {
				user: { id: 'p', name: 'Pat', email: 'pat@example.com', role: 'member' as const },
				localNetworkMode: false,
				now: Date.parse('2026-11-07T12:00:00.000Z'),
				machine: TEST_MACHINE,
				grants: [
					{ permission: 'view', consent: 'ask' },
					{ permission: 'desktop-view', consent: 'ask' }
				]
			}
		});
		await expect.element(screen.getByText(/asks the person at the screen first/)).toBeVisible();
		expect(screen.container.querySelector('button')?.textContent ?? '').not.toContain('Watch');
	});
});
