import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeSocket } from '#tests/helpers/fake-socket.ts';
import { TEST_MACHINE } from '#tests/helpers/machines.ts';
import { TerminalSession } from './terminal-session.svelte.ts';

const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const CONNECTING = 0;

beforeEach(() => {
	sessionStorage.clear();
	FakeSocket.last = undefined;
	vi.stubGlobal('WebSocket', FakeSocket);
	vi.stubGlobal(
		'fetch',
		vi.fn((url: string) =>
			Promise.resolve(
				url.endsWith('/browser-ticket')
					? Response.json({ kind: 'issued', browserTicket: 'ticket-2' }, { status: 200 })
					: Response.json({ sessionId: SESSION_ID, browserTicket: 'ticket-1' }, { status: 200 })
			)
		)
	);
});

function resizes(socket: FakeSocket): unknown[] {
	return socket
		.messages()
		.filter((message) => typeof message === 'object' && message !== null && 'cols' in message);
}

async function started(): Promise<{ session: TerminalSession; socket: FakeSocket }> {
	const session = new TerminalSession(TEST_MACHINE.id, {
		write: () => undefined,
		reset: () => undefined
	});
	await session.start('bash', 40, 30);
	const socket = FakeSocket.last;
	if (socket === undefined) throw new Error('no socket');
	return { session, socket };
}

describe('T10: the shell always gets the terminal’s latest size', () => {
	it('a resize made before the socket opened goes once the server attaches it', async () => {
		const { session, socket } = await started();
		socket.readyState = CONNECTING;
		session.resize(96, 20);
		expect(resizes(socket)).toEqual([]);

		socket.readyState = FakeSocket.OPEN;
		socket.receive(JSON.stringify({ type: 'attached', resumed: false }));
		expect(resizes(socket)).toEqual([{ type: 'resize', cols: 96, rows: 20 }]);
	});

	it('sends a size once, and again only when it changes', async () => {
		const { session, socket } = await started();
		socket.receive(JSON.stringify({ type: 'attached', resumed: false }));
		session.resize(96, 20);
		session.resize(96, 20);
		session.resize(120, 24);
		expect(resizes(socket)).toEqual([
			{ type: 'resize', cols: 40, rows: 30 },
			{ type: 'resize', cols: 96, rows: 20 },
			{ type: 'resize', cols: 120, rows: 24 }
		]);
	});

	it('a resize made while reconnecting reaches the shell on the new socket', async () => {
		const { session, socket } = await started();
		socket.receive(JSON.stringify({ type: 'attached', resumed: false }));
		socket.drop();
		session.resize(96, 20);
		await expect.poll(() => FakeSocket.last !== socket, { timeout: 5000 }).toBe(true);
		const next = FakeSocket.last;
		if (next === undefined) throw new Error('no socket');
		next.receive(JSON.stringify({ type: 'attached', resumed: true }));
		expect(resizes(next)).toEqual([{ type: 'resize', cols: 96, rows: 20 }]);
	});
});
