import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { enrolFakeAgent, type FakeAgent } from '#tests/helpers/fake-agent.ts';
import { addTestUser, NOW } from '#tests/helpers/people.ts';
import { database } from '../database/app-database.ts';
import { env } from '../env.ts';
import {
	agentConnected,
	agentDisconnected,
	type LivePeer
} from '../services/agents/live-agents.ts';
import { sessionRelay } from '../services/sessions/relay.ts';
import { openTerminalSession } from '../services/sessions/sessions.ts';
import { toConsoleUser } from '../services/users/users.ts';
import { attachSocketRoutes } from './attach.ts';
import { SOCKET_ROUTES } from './socket-route-table.ts';

/**
 * The session sockets through the real upgrade path (attach.ts) with real
 * WebSocket clients: a pretend agent and a pretend browser (SPEC-SESSIONS T4).
 */

let server: Server;
let base: string;
let agent: FakeAgent;
let lastTimestamp = Date.now();
const livePeer: LivePeer = { send: () => undefined, close: () => undefined };

beforeAll(async () => {
	server = createServer();
	attachSocketRoutes(server, () => Promise.resolve(SOCKET_ROUTES), 'refuse');
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
	agent = enrolFakeAgent(database, Date.now());
	agentConnected(agent.machineId, livePeer);
});

afterAll(async () => {
	agentDisconnected(agent.machineId, livePeer);
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
});

async function openSession(): Promise<{ sessionId: string; browserTicket: string }> {
	const admin = toConsoleUser(
		await addTestUser(database, {
			email: `admin-${crypto.randomUUID()}@example.com`,
			role: 'admin',
			password: null
		})
	);
	const result = openTerminalSession(
		database,
		sessionRelay(),
		env.secretsKey,
		admin,
		agent.machineId,
		{ kind: 'terminal', shell: 'bash', cols: 80, rows: 24 },
		'127.0.0.1',
		NOW
	);
	if (result.kind !== 'opened') throw new Error(result.message);
	return result.reply;
}

function opened(socket: WebSocket): Promise<void> {
	return new Promise((resolve, reject) => {
		socket.once('open', () => {
			resolve();
		});
		socket.once('unexpected-response', (_request, response) => {
			reject(new Error(`refused with ${String(response.statusCode)}`));
		});
		socket.once('error', reject);
	});
}

/** The agent's session socket, with a signed upgrade like the Rust agent's. */
function agentSocket(sessionId: string): WebSocket {
	const path = `/agent/v1/sessions/${sessionId}`;
	lastTimestamp = Math.max(Date.now(), lastTimestamp + 1);
	const signed = agent.signed('GET', path, '', lastTimestamp);
	return new WebSocket(`${base}${path}`, {
		headers: { authorization: signed.authorization ?? '' }
	});
}

function browserSocket(sessionId: string, ticket: string): WebSocket {
	return new WebSocket(`${base}/api/sessions/${sessionId}/socket?ticket=${ticket}`);
}

function nextBinary(socket: WebSocket): Promise<Buffer> {
	return new Promise((resolve) => {
		socket.on('message', function listener(data, isBinary) {
			if (isBinary) {
				socket.off('message', listener);
				resolve(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
			}
		});
	});
}

describe('session sockets (T4)', () => {
	it('relay bytes between the agent and the browser untouched', async () => {
		const { sessionId, browserTicket } = await openSession();
		const fromAgent = agentSocket(sessionId);
		await opened(fromAgent);
		const browser = browserSocket(sessionId, browserTicket);
		const texts: unknown[] = [];
		browser.on('message', (data, isBinary) => {
			if (!isBinary) texts.push(JSON.parse(Buffer.from(data as Buffer).toString('utf8')));
		});
		await opened(browser);

		const typed = nextBinary(fromAgent);
		browser.send(Buffer.from('echo $((6*7))\r'));
		expect((await typed).toString()).toBe('echo $((6*7))\r');

		const shown = nextBinary(browser);
		fromAgent.send(Buffer.from([0x34, 0x32, 0x0d, 0x0a, 0xc3]));
		expect(await shown).toEqual(Buffer.from([0x34, 0x32, 0x0d, 0x0a, 0xc3]));
		expect(texts).toEqual([{ type: 'attached', resumed: false }, { type: 'ready' }]);

		browser.send(JSON.stringify({ type: 'end' }));
		await new Promise((resolve) => fromAgent.once('close', resolve));
	});

	it('refuse a browser without a good ticket and an agent without a good signature', async () => {
		const { sessionId } = await openSession();
		await expect(opened(browserSocket(sessionId, 'made-up'))).rejects.toThrow('401');
		const unsigned = new WebSocket(`${base}/agent/v1/sessions/${sessionId}`);
		await expect(opened(unsigned)).rejects.toThrow('401');
		const unknown = agentSocket(crypto.randomUUID());
		await expect(opened(unknown)).rejects.toThrow('404');
		sessionRelay().end(sessionId, 'closed', 'test over');
	});

	it('stop reading from the agent while the browser is not reading, so server memory stays flat', async () => {
		const { sessionId, browserTicket } = await openSession();
		const fromAgent = agentSocket(sessionId);
		await opened(fromAgent);
		const browser = browserSocket(sessionId, browserTicket);
		await opened(browser);
		browser.pause();

		const chunk = Buffer.alloc(64 * 1024, 0x79);
		const limit = 256 * 1024 * 1024;
		let sent = 0;
		// Write as fast as the server takes it. Unpaused it would take all 256 MB.
		while (sent < limit && fromAgent.bufferedAmount < 8 * 1024 * 1024) {
			fromAgent.send(chunk);
			sent += chunk.byteLength;
			await new Promise((resolve) => setImmediate(resolve));
		}
		expect(fromAgent.bufferedAmount).toBeGreaterThanOrEqual(8 * 1024 * 1024);
		expect(sent).toBeLessThan(64 * 1024 * 1024);

		// Reading again drains the agent's queue.
		let received = 0;
		browser.on('message', (data) => {
			received += (data as Buffer).byteLength;
		});
		browser.resume();
		await expect.poll(() => fromAgent.bufferedAmount, { timeout: 10_000 }).toBe(0);
		await expect.poll(() => received, { timeout: 10_000 }).toBe(sent);
		sessionRelay().end(sessionId, 'closed', 'test over');
	});
});
