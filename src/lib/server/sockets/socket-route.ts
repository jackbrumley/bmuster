/**
 * WebSocket routes. SvelteKit has no socket support yet, so socket routes are
 * declared here, listed in socket-route-table.ts, and attached to the HTTP
 * server by server.ts (production) and vite-plugin.ts (development).
 * Upgrade requests skip hooks.server.ts: each route authenticates itself.
 */

/** One connection, as a route's handlers see it. */
export type SocketPeer<Context> = {
	readonly context: Context;
	send(data: string): void;
	/** Sends bytes; `sent` runs once they are handed to the network (backpressure). */
	sendBinary(data: Uint8Array, sent: () => void): void;
	/** Stops (and restarts) reading from this connection, so its sender slows down. */
	pause(): void;
	resume(): void;
	close(code: number, reason: string): void;
};

/** Refused upgrade: sent as JSON `{ reason, message }` with this status. */
export type SocketRefusal = {
	refused: true;
	status: 400 | 401 | 403 | 404 | 409;
	reason: string;
	message: string;
};

/** `[name]` segments of a route's path, e.g. `{ id: '…' }` for `/agent/v1/sessions/[id]`. */
export type PathParams = Readonly<Record<string, string>>;

export type SocketRouteHandlers<Context> = {
	/** The path, with `[name]` for a segment that varies, e.g. `/agent/v1/sessions/[id]`. */
	readonly path: string;
	upgrade(request: Request, params: PathParams): Promise<Context | SocketRefusal>;
	open(peer: SocketPeer<Context>): void;
	message(peer: SocketPeer<Context>, data: string): void;
	binary(peer: SocketPeer<Context>, data: Uint8Array): void;
	close(peer: SocketPeer<Context>): void;
};

/** The transport side of one connection, provided by attach.ts. */
type SocketConnection = Omit<SocketPeer<never>, 'context'>;

type SocketSession = {
	open(): void;
	message(data: string): void;
	binary(data: Uint8Array): void;
	close(): void;
};

export type SocketRoute = {
	readonly path: string;
	accept(
		request: Request,
		params: PathParams,
		connection: SocketConnection
	): Promise<SocketSession | SocketRefusal>;
};

export function isSocketRefusal(value: unknown): value is SocketRefusal {
	return (
		typeof value === 'object' && value !== null && 'refused' in value && value.refused === true
	);
}

/** Segments of at most 64 URL-safe characters; nothing else matches a `[name]`. */
const PARAM_VALUE = /^[A-Za-z0-9_-]{1,64}$/;

/** The route's parameters when `pathname` matches its `path`, or undefined. */
export function matchSocketPath(path: string, pathname: string): PathParams | undefined {
	const wanted = path.split('/');
	const actual = pathname.split('/');
	if (wanted.length !== actual.length) {
		return undefined;
	}
	const params: Record<string, string> = {};
	for (const [index, segment] of wanted.entries()) {
		const value = actual[index] ?? '';
		const name = /^\[([a-z][a-zA-Z]*)\]$/.exec(segment)?.[1];
		if (name === undefined) {
			if (segment !== value) {
				return undefined;
			}
		} else if (PARAM_VALUE.test(value)) {
			params[name] = value;
		} else {
			return undefined;
		}
	}
	return params;
}

/** Declares a socket route; the context `upgrade` returns is typed through to the other handlers. */
export function defineSocketRoute<Context>(handlers: SocketRouteHandlers<Context>): SocketRoute {
	return {
		path: handlers.path,
		async accept(request, params, connection) {
			const context = await handlers.upgrade(request, params);
			if (isSocketRefusal(context)) {
				return context;
			}
			const peer: SocketPeer<Context> = {
				context,
				send: (data) => {
					connection.send(data);
				},
				sendBinary: (data, sent) => {
					connection.sendBinary(data, sent);
				},
				pause: () => {
					connection.pause();
				},
				resume: () => {
					connection.resume();
				},
				close: (code, reason) => {
					connection.close(code, reason);
				}
			};
			return {
				open: () => {
					handlers.open(peer);
				},
				message: (data) => {
					handlers.message(peer, data);
				},
				binary: (data) => {
					handlers.binary(peer, data);
				},
				close: () => {
					handlers.close(peer);
				}
			};
		}
	};
}

export function isSocketRoute(value: unknown): value is SocketRoute {
	return (
		typeof value === 'object' &&
		value !== null &&
		'path' in value &&
		typeof value.path === 'string' &&
		'accept' in value &&
		typeof value.accept === 'function'
	);
}
