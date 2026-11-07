import {
	TERMINAL_SHELLS,
	type BrowserControl,
	type TerminalShell
} from '#lib/domain/sessions/session.ts';
import {
	browserTicketReplySchema,
	openSessionReplySchema,
	serverControlSchema
} from '#lib/schemas/sessions/sessions.ts';
import { apiRequest } from '#lib/utils/api-client.ts';

/**
 * One terminal session as the page sees it (SPEC-SESSIONS T1, T4, T6): asks
 * the server for a session, connects the browser's socket with the ticket,
 * and comes back to the same session after a reload or a dropped connection
 * (AGENTS.md §13). The session lives on the server; this only watches it.
 */

export type Connection =
	| { kind: 'idle' }
	| { kind: 'starting' }
	| { kind: 'connecting' }
	/** `ready`: the machine's end is open, so typing reaches the shell. */
	| { kind: 'live'; ready: boolean; sinceMs: number }
	| { kind: 'reconnecting' }
	/** Another window took the session over. */
	| { kind: 'moved' }
	| { kind: 'ended'; message: string };

/** Where the session's output goes. */
export type ScreenSink = {
	write(bytes: Uint8Array): void;
	reset(): void;
};

type Saved = { sessionId: string; shell: TerminalShell; sinceMs: number };

/** How long the server keeps a session with no browser; reconnecting stops a little before. */
const RECONNECT_FOR_MS = 55_000;

/** Close codes from the server (relay.ts). */
const CLOSE_ENDED = 4000;
const CLOSE_REPLACED = 4001;

function storageKey(machineId: string): string {
	return `bmuster.terminal.${machineId}`;
}

/** The running session this tab had open, if any (per tab, survives a reload). */
function readSaved(machineId: string): Saved | undefined {
	try {
		const text = sessionStorage.getItem(storageKey(machineId));
		if (text === null) {
			return undefined;
		}
		const value: unknown = JSON.parse(text);
		if (
			typeof value === 'object' &&
			value !== null &&
			'sessionId' in value &&
			typeof value.sessionId === 'string' &&
			'shell' in value &&
			typeof value.shell === 'string' &&
			'sinceMs' in value &&
			typeof value.sinceMs === 'number'
		) {
			const shell = value.shell;
			return isShell(shell)
				? { sessionId: value.sessionId, shell, sinceMs: value.sinceMs }
				: undefined;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

function isShell(text: string): text is TerminalShell {
	return TERMINAL_SHELLS.some((shell) => shell === text);
}

function writeSaved(machineId: string, saved: Saved | undefined): void {
	try {
		if (saved === undefined) {
			sessionStorage.removeItem(storageKey(machineId));
		} else {
			sessionStorage.setItem(storageKey(machineId), JSON.stringify(saved));
		}
	} catch {
		// Private windows can refuse storage; the session then ends with the page.
	}
}

function socketUrl(sessionId: string, ticket: string): string {
	const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
	return `${scheme}//${window.location.host}/api/sessions/${sessionId}/socket?ticket=${encodeURIComponent(ticket)}`;
}

export class TerminalSession {
	connection = $state<Connection>({ kind: 'idle' });
	/** The shell of the session this tab has, once one started. */
	shell = $state<TerminalShell | undefined>(undefined);

	readonly #machineId: string;
	readonly #screen: ScreenSink;
	readonly #encoder = new TextEncoder();
	#socket: WebSocket | undefined;
	#sessionId: string | undefined;
	#sinceMs = 0;
	#size = { cols: 0, rows: 0 };
	#reconnectUntil = 0;
	#retryTimer: ReturnType<typeof setTimeout> | undefined;
	#detached = false;

	constructor(machineId: string, screen: ScreenSink) {
		this.#machineId = machineId;
		this.#screen = screen;
	}

	/** Comes back to this tab's running session after a reload; false when there is none. */
	async resume(): Promise<boolean> {
		const saved = readSaved(this.#machineId);
		if (saved === undefined) {
			return false;
		}
		this.#sessionId = saved.sessionId;
		this.#sinceMs = saved.sinceMs;
		this.shell = saved.shell;
		this.connection = { kind: 'connecting' };
		await this.#reattach();
		return true;
	}

	async start(shell: TerminalShell, cols: number, rows: number): Promise<void> {
		this.#closeSocket();
		this.connection = { kind: 'starting' };
		this.#size = { cols, rows };
		const result = await apiRequest({
			method: 'POST',
			url: `/api/machines/${this.#machineId}/sessions`,
			body: { kind: 'terminal', shell, cols, rows },
			reply: openSessionReplySchema
		});
		if (!result.ok) {
			this.connection = { kind: 'ended', message: result.message };
			return;
		}
		this.#sessionId = result.data.sessionId;
		this.#sinceMs = Date.now();
		this.shell = shell;
		writeSaved(this.#machineId, {
			sessionId: result.data.sessionId,
			shell,
			sinceMs: this.#sinceMs
		});
		this.#screen.reset();
		this.#connect(result.data.sessionId, result.data.browserTicket);
	}

	/** Typing (and the extra keys) as UTF-8. */
	send(data: string): void {
		if (this.#socket?.readyState === WebSocket.OPEN) {
			this.#socket.send(this.#encoder.encode(data));
		}
	}

	resize(cols: number, rows: number): void {
		if (cols === this.#size.cols && rows === this.#size.rows) {
			return;
		}
		this.#size = { cols, rows };
		this.#control({ type: 'resize', cols, rows });
	}

	/** Ends the session on the machine (the shell and everything it started). */
	end(): void {
		this.#control({ type: 'end' });
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

	#control(message: BrowserControl): void {
		if (this.#socket?.readyState === WebSocket.OPEN) {
			this.#socket.send(JSON.stringify(message));
		}
	}

	#closeSocket(): void {
		const socket = this.#socket;
		this.#socket = undefined;
		socket?.close(1000, 'Leaving');
	}

	#ended(message: string): void {
		this.#closeSocket();
		writeSaved(this.#machineId, undefined);
		this.connection = { kind: 'ended', message };
	}

	async #reattach(): Promise<void> {
		const sessionId = this.#sessionId;
		if (sessionId === undefined || this.#isDetached()) {
			return;
		}
		const result = await apiRequest({
			method: 'POST',
			url: `/api/sessions/${sessionId}/browser-ticket`,
			body: undefined,
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
				this.#screen.write(new Uint8Array(event.data));
				return;
			}
			if (typeof event.data === 'string') {
				this.#onControl(event.data);
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

	#onControl(text: string): void {
		let json: unknown;
		try {
			json = JSON.parse(text);
		} catch {
			return;
		}
		const parsed = serverControlSchema.safeParse(json);
		if (!parsed.success) {
			return;
		}
		switch (parsed.data.type) {
			case 'attached':
				if (parsed.data.resumed) {
					// The server replays recent output next; start from a clean screen.
					this.#screen.reset();
				}
				this.connection = { kind: 'live', ready: false, sinceMs: this.#sinceMs };
				if (this.#size.cols > 0) {
					this.#control({ type: 'resize', cols: this.#size.cols, rows: this.#size.rows });
				}
				return;
			case 'ready':
				this.connection = { kind: 'live', ready: true, sinceMs: this.#sinceMs };
				return;
			case 'ended':
				this.#ended(parsed.data.message);
				return;
		}
	}
}
