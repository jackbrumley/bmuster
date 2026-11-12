import {
	browserTicketReplySchema,
	openSessionReplySchema,
	serverControlSchema,
	type OpenSessionRequest
} from '#lib/schemas/sessions/sessions.ts';
import type { DesktopMode } from '#lib/domain/sessions/session.ts';
import { apiRequest } from '#lib/utils/api-client.ts';
import { announceAgentLost } from './machine-presence.svelte.ts';

/**
 * One session's link to the server, as a page sees it (SPEC-SESSIONS T4,
 * T6; SPEC-DESKTOP R2): asks for a session, connects the browser's socket
 * with the ticket, and comes back to the same session after a reload or a
 * dropped connection (AGENTS.md §13). The session lives on the server; this
 * only watches it. Terminal and desktop pages build on it; what the frames
 * mean is theirs.
 */

export type Connection =
	| { kind: 'idle' }
	| { kind: 'starting' }
	| { kind: 'connecting' }
	/** `ready`: the machine's end is open, so input reaches it. */
	| { kind: 'live'; ready: boolean; sinceMs: number }
	| { kind: 'reconnecting' }
	/** Another window took the session over. */
	| { kind: 'moved' }
	| { kind: 'ended'; message: string };

/** What the page hears from the link. */
export type LinkEvents = {
	/** The socket is attached; `resumed` when coming back to a running session. */
	attached(resumed: boolean): void;
	/** The machine's end is open. */
	ready(): void;
	binary(data: Uint8Array): void;
	/** A text frame that is not the server's own control message. */
	text(text: string): void;
	/** The session ended (also after a reload finds it gone). */
	ended(): void;
};

/**
 * Where a session is asked for and reattached: the console's own endpoints, or a share
 * link's guest endpoints (SPEC-SHARE-LINKS). The socket is the same for both.
 */
export type SessionRoute = {
	/** POST here with the open request; the reply is the session and a browser ticket. */
	openUrl: string;
	/** The request for a fresh browser ticket for this running session. */
	ticket(sessionId: string): { url: string; body: unknown };
	/** Where this tab remembers its running session (sessionStorage). */
	storageKey: string;
};

/** The console's endpoints for a person's own sessions on a machine. */
export function consoleSessionRoute(
	kind: OpenSessionRequest['kind'],
	machineId: string
): SessionRoute {
	return {
		openUrl: `/api/machines/${machineId}/sessions`,
		ticket: (sessionId) => ({ url: `/api/sessions/${sessionId}/browser-ticket`, body: undefined }),
		storageKey: `bmuster.${kind}.${machineId}`
	};
}

/** What is kept per tab: the session, when it started, and the page's own tag (shell or mode). */
type Saved = { sessionId: string; sinceMs: number; tag: string };

/** How long the server keeps a session with no browser; reconnecting stops a little before. */
const RECONNECT_FOR_MS = 55_000;

/** Close codes from the server (relay.ts). */
const CLOSE_ENDED = 4000;
const CLOSE_REPLACED = 4001;

function readSaved(key: string): Saved | undefined {
	try {
		const text = sessionStorage.getItem(key);
		if (text === null) {
			return undefined;
		}
		const value: unknown = JSON.parse(text);
		if (
			typeof value === 'object' &&
			value !== null &&
			'sessionId' in value &&
			typeof value.sessionId === 'string' &&
			'tag' in value &&
			typeof value.tag === 'string' &&
			'sinceMs' in value &&
			typeof value.sinceMs === 'number'
		) {
			return { sessionId: value.sessionId, tag: value.tag, sinceMs: value.sinceMs };
		}
		return undefined;
	} catch {
		return undefined;
	}
}

function writeSaved(key: string, saved: Saved | undefined): void {
	try {
		if (saved === undefined) {
			sessionStorage.removeItem(key);
		} else {
			sessionStorage.setItem(key, JSON.stringify(saved));
		}
	} catch {
		// Private windows can refuse storage; the session then ends with the page.
	}
}

function socketUrl(sessionId: string, ticket: string): string {
	const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
	return `${scheme}//${window.location.host}/api/sessions/${sessionId}/socket?ticket=${encodeURIComponent(ticket)}`;
}

export class SessionLink {
	connection = $state<Connection>({ kind: 'idle' });

	readonly #machineId: string;
	readonly #route: SessionRoute;
	readonly #storageKey: string;
	readonly #events: LinkEvents;
	#socket: WebSocket | undefined;
	#sessionId: string | undefined;
	#sinceMs = 0;
	#reconnectUntil = 0;
	#retryTimer: ReturnType<typeof setTimeout> | undefined;
	#detached = false;

	constructor(route: SessionRoute, machineId: string, events: LinkEvents) {
		this.#machineId = machineId;
		this.#route = route;
		this.#storageKey = route.storageKey;
		this.#events = events;
	}

	/** Comes back to this tab's running session after a reload: its tag, or undefined when there is none. */
	async resume(): Promise<string | undefined> {
		const saved = readSaved(this.#storageKey);
		if (saved === undefined) {
			return undefined;
		}
		this.#sessionId = saved.sessionId;
		this.#sinceMs = saved.sinceMs;
		this.connection = { kind: 'connecting' };
		await this.#reattach();
		return saved.tag;
	}

	/**
	 * Asks for a new session; false when the server refused (the reason is in `connection`).
	 * The body is the console's open request, or a guest's `{ mode }`.
	 */
	async start(request: OpenSessionRequest | { mode: DesktopMode }, tag: string): Promise<boolean> {
		this.#closeSocket();
		this.connection = { kind: 'starting' };
		const result = await apiRequest({
			method: 'POST',
			url: this.#route.openUrl,
			body: request,
			reply: openSessionReplySchema
		});
		if (!result.ok) {
			this.connection = { kind: 'ended', message: result.message };
			return false;
		}
		this.#sessionId = result.data.sessionId;
		this.#sinceMs = Date.now();
		writeSaved(this.#storageKey, {
			sessionId: result.data.sessionId,
			tag,
			sinceMs: this.#sinceMs
		});
		this.#connect(result.data.sessionId, result.data.browserTicket);
		return true;
	}

	/** True while the socket is open. */
	get open(): boolean {
		return this.#socket?.readyState === WebSocket.OPEN;
	}

	sendText(text: string): void {
		if (this.#socket?.readyState === WebSocket.OPEN) {
			this.#socket.send(text);
		}
	}

	sendBytes(data: Uint8Array<ArrayBuffer>): void {
		if (this.#socket?.readyState === WebSocket.OPEN) {
			this.#socket.send(data);
		}
	}

	/** Ends the session on the machine. */
	end(): void {
		this.sendText(JSON.stringify({ type: 'end' }));
	}

	/** Takes the session back from another window. */
	async takeBack(): Promise<void> {
		this.connection = { kind: 'connecting' };
		await this.#reattach();
	}

	/** The page is going away: let go of the socket, not the session (it can come back). */
	detach(): void {
		this.#detached = true;
		clearTimeout(this.#retryTimer);
		this.#closeSocket();
	}

	#isDetached(): boolean {
		return this.#detached;
	}

	#closeSocket(): void {
		const socket = this.#socket;
		this.#socket = undefined;
		socket?.close(1000, 'Leaving');
	}

	#ended(message: string): void {
		this.#closeSocket();
		writeSaved(this.#storageKey, undefined);
		this.connection = { kind: 'ended', message };
		this.#events.ended();
	}

	async #reattach(): Promise<void> {
		const sessionId = this.#sessionId;
		if (sessionId === undefined || this.#isDetached()) {
			return;
		}
		const ticket = this.#route.ticket(sessionId);
		const result = await apiRequest({
			method: 'POST',
			url: ticket.url,
			body: ticket.body,
			reply: browserTicketReplySchema
		});
		// The page may have gone while the request was out.
		if (this.#isDetached()) {
			return;
		}
		if (!result.ok) {
			// The server could not be reached: try again while the session can still be there.
			this.#retryLater();
			return;
		}
		switch (result.data.kind) {
			case 'issued':
				this.#connect(sessionId, result.data.browserTicket);
				return;
			case 'ended':
				this.#ended(result.data.message);
				return;
		}
	}

	#retryLater(): void {
		if (Date.now() >= this.#reconnectUntil) {
			this.#ended('Lost the connection to the server.');
			return;
		}
		this.connection = { kind: 'reconnecting' };
		clearTimeout(this.#retryTimer);
		this.#retryTimer = setTimeout(() => {
			void this.#reattach();
		}, 2000);
	}

	#connect(sessionId: string, ticket: string): void {
		this.#closeSocket();
		if (this.connection.kind !== 'reconnecting') {
			this.connection = { kind: 'connecting' };
		}
		const socket = new WebSocket(socketUrl(sessionId, ticket));
		socket.binaryType = 'arraybuffer';
		this.#socket = socket;
		socket.addEventListener('message', (event: MessageEvent<unknown>) => {
			if (this.#socket !== socket) {
				return;
			}
			if (event.data instanceof ArrayBuffer) {
				this.#events.binary(new Uint8Array(event.data));
				return;
			}
			if (typeof event.data === 'string') {
				this.#onText(event.data);
			}
		});
		socket.addEventListener('close', (event) => {
			if (this.#socket !== socket) {
				return;
			}
			this.#socket = undefined;
			if (this.#detached || this.connection.kind === 'ended') {
				return;
			}
			if (event.code === CLOSE_REPLACED) {
				this.connection = { kind: 'moved' };
				return;
			}
			if (event.code === CLOSE_ENDED) {
				this.#ended('The session has ended.');
				return;
			}
			if (this.connection.kind === 'live' || this.connection.kind === 'connecting') {
				this.#reconnectUntil = Date.now() + RECONNECT_FOR_MS;
			}
			this.#retryLater();
		});
	}

	#onText(text: string): void {
		let json: unknown;
		try {
			json = JSON.parse(text);
		} catch {
			return;
		}
		const parsed = serverControlSchema.safeParse(json);
		if (!parsed.success) {
			this.#events.text(text);
			return;
		}
		switch (parsed.data.type) {
			case 'attached':
				this.connection = { kind: 'live', ready: false, sinceMs: this.#sinceMs };
				this.#events.attached(parsed.data.resumed);
				return;
			case 'ready':
				this.connection = { kind: 'live', ready: true, sinceMs: this.#sinceMs };
				this.#events.ready();
				return;
			case 'ended':
				// The machine's socket went with it: the page's status says so at once (SPEC-PRESENCE P11).
				if (parsed.data.reason === 'agent-lost') {
					announceAgentLost(this.#machineId);
				}
				this.#ended(parsed.data.message);
				return;
		}
	}
}
