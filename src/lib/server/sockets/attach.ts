import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { isSocketRefusal, type SocketRoute } from './socket-route.ts';

/** Every connection is pinged this often; one that misses a pong is dropped. */
const PING_MS = 30_000;

/**
 * Attaches socket routes to a Node HTTP server. `routes` is read on every
 * upgrade so the dev server can hand over freshly reloaded modules.
 * Production refuses unknown paths; the dev server leaves them to Vite.
 */
/** Anything that emits Node's `upgrade` event: http.Server, Vite's dev server. */
export type UpgradeSource = {
	on(
		event: 'upgrade',
		listener: (incoming: IncomingMessage, stream: Duplex, head: Buffer) => void
	): unknown;
};

export function attachSocketRoutes(
	server: UpgradeSource,
	routes: () => Promise<readonly SocketRoute[]>,
	unmatched: 'refuse' | 'ignore'
): void {
	const sockets = new WebSocketServer({ noServer: true });
	const alive = new WeakMap<WebSocket, boolean>();

	const pinger = setInterval(() => {
		for (const socket of sockets.clients) {
			if (alive.get(socket) === false) {
				socket.terminate();
				continue;
			}
			alive.set(socket, false);
			socket.ping();
		}
	}, PING_MS);
	pinger.unref();

	server.on('upgrade', (incoming: IncomingMessage, stream: Duplex, head: Buffer) => {
		if (incoming.headers['sec-websocket-protocol']?.includes('vite-hmr') === true) {
			return;
		}
		upgrade(incoming, stream, head).catch((error: unknown) => {
			process.stderr.write(`Socket upgrade failed: ${String(error)}\n`);
			reject(stream, 500, { reason: 'server-error', message: 'Internal Server Error' });
		});
	});

	async function upgrade(incoming: IncomingMessage, stream: Duplex, head: Buffer): Promise<void> {
		const request = toRequest(incoming);
		const pathname = new URL(request.url).pathname;
		const route = (await routes()).find((candidate) => candidate.path === pathname);
		if (route === undefined) {
			if (unmatched === 'refuse') {
				reject(stream, 404, { reason: 'not-found', message: 'Not Found' });
			}
			return;
		}
		let socket: WebSocket | undefined;
		const session = await route.accept(request, {
			send: (data) => socket?.send(data),
			close: (code, reason) => socket?.close(code, reason)
		});
		if (isSocketRefusal(session)) {
			reject(stream, session.status, { reason: session.reason, message: session.message });
			return;
		}
		sockets.handleUpgrade(incoming, stream, head, (accepted) => {
			socket = accepted;
			alive.set(accepted, true);
			accepted.on('pong', () => alive.set(accepted, true));
			accepted.on('message', (data, isBinary) => {
				if (!isBinary) {
					session.message(textOf(data));
				}
			});
			accepted.on('close', () => {
				session.close();
			});
			accepted.on('error', () => {
				accepted.terminate();
			});
			session.open();
		});
	}
}

/** The upgrade request as a WHATWG Request (headers only). */
function toRequest(incoming: IncomingMessage): Request {
	const headers = new Headers();
	for (const [name, value] of Object.entries(incoming.headers)) {
		if (value !== undefined) {
			headers.set(name, Array.isArray(value) ? value.join(', ') : value);
		}
	}
	return new Request(
		new URL(incoming.url ?? '/', `http://${incoming.headers.host ?? 'localhost'}`),
		{
			headers
		}
	);
}

function reject(stream: Duplex, status: number, body: { reason: string; message: string }): void {
	if (!stream.destroyed) {
		const json = JSON.stringify(body);
		stream.end(
			`HTTP/1.1 ${status} Refused\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`
		);
	}
}

function textOf(data: Buffer | ArrayBuffer | Buffer[]): string {
	if (Array.isArray(data)) {
		return Buffer.concat(data).toString('utf8');
	}
	return Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data).toString('utf8');
}
