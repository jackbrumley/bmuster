/**
 * WebSocket routes. SvelteKit has no socket support yet, so socket routes are
 * declared here, listed in socket-route-table.ts, and attached to the HTTP
 * server by server.ts (production) and vite-plugin.ts (development).
 * Upgrade requests skip hooks.server.ts: each route authenticates itself.
 */

type SocketPeer<Context> = {
	readonly context: Context;
	send(data: string): void;
	close(code: number, reason: string): void;
};

/** Refused upgrade: sent as JSON `{ reason, message }` with this status. */
export type SocketRefusal = {
	refused: true;
	status: 400 | 401 | 403 | 404 | 409;
	reason: string;
	message: string;
};

export type SocketRouteHandlers<Context> = {
	/** Exact path, e.g. `/agent/v1/socket`. */
	readonly path: string;
	upgrade(request: Request): Promise<Context | SocketRefusal>;
	open(peer: SocketPeer<Context>): void;
	message(peer: SocketPeer<Context>, data: string): void;
	close(peer: SocketPeer<Context>): void;
};

/** The transport side of one connection, provided by attach.ts. */
type SocketConnection = {
	send(data: string): void;
	close(code: number, reason: string): void;
};

type SocketSession = {
	open(): void;
	message(data: string): void;
	close(): void;
};

export type SocketRoute = {
	readonly path: string;
	accept(request: Request, connection: SocketConnection): Promise<SocketSession | SocketRefusal>;
};

export function isSocketRefusal(value: unknown): value is SocketRefusal {
	return (
		typeof value === 'object' && value !== null && 'refused' in value && value.refused === true
	);
}

/** Declares a socket route; the context `upgrade` returns is typed through to the other handlers. */
export function defineSocketRoute<Context>(handlers: SocketRouteHandlers<Context>): SocketRoute {
	return {
		path: handlers.path,
		async accept(request, connection) {
			const context = await handlers.upgrade(request);
			if (isSocketRefusal(context)) {
				return context;
			}
			const peer: SocketPeer<Context> = {
				context,
				send: (data) => {
					connection.send(data);
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
