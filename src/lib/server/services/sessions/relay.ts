import { randomBytes } from 'node:crypto';
import {
	endReasonLabel,
	type DesktopMode,
	type ServerControl,
	type SessionEndReason,
	type SessionInUse,
	type TerminalShell
} from '#lib/domain/sessions/session.ts';
import { agentSessionEventSchema, browserControlSchema } from '#lib/schemas/sessions/sessions.ts';
import { OutputRing } from './output-ring.ts';

/**
 * The session relay (SPEC-SESSIONS T4, T6; AGENTS.md §13): joins one
 * agent's session socket to one browser's, in memory. Bytes pass through as
 * they are; only the small JSON control messages are read. It never touches
 * the database: whoever starts a session is told when it ends.
 *
 * Backpressure: bytes still waiting to be written to one side are counted;
 * above the high-water mark the other side's socket is paused (no more is
 * read from it, so TCP slows its sender), below the low-water mark it
 * resumes. A slow browser so pauses the agent, which pauses the shell.
 *
 * Reloads: the browser can go away for up to a minute and come back with a
 * fresh ticket; the last 256 KB of output are replayed when it does.
 *
 * File sessions (SPEC-FILES) have no browser socket: the server itself is
 * the other end (a `LocalEnd`), sending requests and reading the replies.
 * The relay still owns their lifetime, their agent socket and "In use".
 *
 * Desktop sessions (SPEC-DESKTOP) talk in text frames both ways (JSON
 * control messages the relay passes on unread) besides the agent's binary
 * frames. Nothing is replayed to a reattaching browser: it says `hello`
 * again and the agent sends a fresh keyframe.
 */

export type RelayLimits = {
	/** The agent must open its session socket within this. */
	agentWaitMs: number;
	/**
	 * A desktop session whose agent socket closed waits this long for a new
	 * one: on Windows the helper moves when the console session changes
	 * (SPEC-DESKTOP 6.2), and a signed-out session's helper is gone first.
	 */
	agentHandoverMs: number;
	/** A session with no browser this long ends (T6). */
	noBrowserMs: number;
	/** A session with no input this long ends. */
	idleMs: number;
	/** Output kept for a reattaching browser. */
	replayBytes: number;
	highWaterBytes: number;
	lowWaterBytes: number;
	/** A browser ticket works once, within this. */
	browserTicketMs: number;
	/** Input kept while the agent is still connecting. */
	earlyInputBytes: number;
};

export const RELAY_LIMITS: RelayLimits = {
	agentWaitMs: 20_000,
	agentHandoverMs: 15_000,
	noBrowserMs: 60_000,
	idleMs: 60 * 60_000,
	replayBytes: 256 * 1024,
	highWaterBytes: 1024 * 1024,
	lowWaterBytes: 256 * 1024,
	browserTicketMs: 30_000,
	earlyInputBytes: 64 * 1024
};

/** One end of a session: a socket, as the socket routes provide it. */
export type RelayPeer = {
	sendText(text: string): void;
	sendBytes(data: Uint8Array, sent: () => void): void;
	pause(): void;
	resume(): void;
	close(code: number, reason: string): void;
};

/** What a session is, from the moment it is asked for. */
export type SessionRecord = {
	id: string;
	machineId: string;
	userId: string;
	userName: string;
	ip: string;
	openedAt: number;
} & (
	| { kind: 'terminal'; shell: TerminalShell }
	| { kind: 'files' }
	| { kind: 'desktop'; mode: DesktopMode }
);

/** The server's own end of a session, in the browser's place (file sessions). */
export type LocalEnd = {
	/** The agent's socket is open: requests can go. */
	ready(): void;
	/** A text frame from the agent that is not its last word. */
	text(text: string): void;
	bytes(data: Uint8Array): void;
};

export type EndedSession = SessionRecord & {
	reason: SessionEndReason;
	message: string;
	endedAt: number;
	/** Bytes from the machine to the browser, and typed in the browser. */
	bytesOut: number;
	bytesIn: number;
};

type Side = {
	peer: RelayPeer | undefined;
	/** Bytes handed to this side's socket and not yet written. */
	waiting: number;
	/** This side's reading is paused because the other side is behind. */
	paused: boolean;
};

type LiveSession = {
	record: SessionRecord;
	id: string;
	machineId: string;
	userId: string;
	local: LocalEnd | undefined;
	onEnded: (session: EndedSession) => void;
	agent: Side;
	browser: Side;
	ring: OutputRing;
	earlyInput: Uint8Array[];
	bytesOut: number;
	bytesIn: number;
	lastInputAt: number;
	everAttached: boolean;
	timers: Map<'agent' | 'browser' | 'idle', ReturnType<typeof setTimeout>>;
};

export type Attach = { kind: 'attached' } | { kind: 'refused'; message: string };

/** Close codes the browser understands. */
export const CLOSE_ENDED = 4000;
export const CLOSE_REPLACED = 4001;

export type Relay = ReturnType<typeof createRelay>;

export function createRelay(limits: RelayLimits) {
	const sessions = new Map<string, LiveSession>();
	const tickets = new Map<string, { sessionId: string; userId: string; expiresAt: number }>();
	const ended = new Map<string, EndedSession>();

	function later(
		session: LiveSession,
		which: 'agent' | 'browser' | 'idle',
		ms: number,
		run: () => void
	): void {
		clearTimeout(session.timers.get(which));
		const timer = setTimeout(run, ms);
		timer.unref();
		session.timers.set(which, timer);
	}

	function cancel(session: LiveSession, which: 'agent' | 'browser' | 'idle'): void {
		clearTimeout(session.timers.get(which));
		session.timers.delete(which);
	}

	function sendControl(peer: RelayPeer | undefined, message: ServerControl): void {
		peer?.sendText(JSON.stringify(message));
	}

	/** Sends `data` to `to`, pausing `from` while `to` is behind. */
	function forward(to: Side, from: Side, data: Uint8Array): void {
		const peer = to.peer;
		if (peer === undefined) {
			return;
		}
		to.waiting += data.byteLength;
		peer.sendBytes(data, () => {
			to.waiting -= data.byteLength;
			if (from.paused && to.waiting <= limits.lowWaterBytes) {
				from.paused = false;
				from.peer?.resume();
			}
		});
		if (!from.paused && to.waiting > limits.highWaterBytes) {
			from.paused = true;
			from.peer?.pause();
		}
	}

	function watchIdle(session: LiveSession): void {
		const left = session.lastInputAt + limits.idleMs - Date.now();
		if (left <= 0) {
			end(session.id, 'idle', 'The session ended after 60 minutes with no input.');
			return;
		}
		later(session, 'idle', left, () => {
			watchIdle(session);
		});
	}

	function end(sessionId: string, reason: SessionEndReason, message: string): void {
		const session = sessions.get(sessionId);
		if (session === undefined) {
			return;
		}
		sessions.delete(sessionId);
		for (const timer of session.timers.values()) {
			clearTimeout(timer);
		}
		for (const [ticket, entry] of tickets) {
			if (entry.sessionId === sessionId) {
				tickets.delete(ticket);
			}
		}
		sendControl(session.browser.peer, { type: 'ended', reason, message });
		session.browser.peer?.close(CLOSE_ENDED, reason);
		session.agent.peer?.close(1000, reason);
		const record: EndedSession = {
			...session.record,
			reason,
			message,
			endedAt: Date.now(),
			bytesOut: session.bytesOut,
			bytesIn: session.bytesIn
		};
		ended.set(sessionId, record);
		const forget = setTimeout(() => ended.delete(sessionId), 10 * 60_000);
		forget.unref();
		session.onEnded(record);
	}

	function live(sessionId: string): LiveSession | undefined {
		return sessions.get(sessionId);
	}

	function track(
		record: SessionRecord,
		onEnded: (session: EndedSession) => void,
		local: LocalEnd | undefined
	): LiveSession {
		const session: LiveSession = {
			record,
			id: record.id,
			machineId: record.machineId,
			userId: record.userId,
			local,
			onEnded,
			agent: { peer: undefined, waiting: 0, paused: false },
			browser: { peer: undefined, waiting: 0, paused: false },
			ring: new OutputRing(limits.replayBytes),
			earlyInput: [],
			bytesOut: 0,
			bytesIn: 0,
			lastInputAt: Date.now(),
			everAttached: false,
			timers: new Map()
		};
		sessions.set(record.id, session);
		later(session, 'agent', limits.agentWaitMs, () => {
			end(record.id, 'agent-timeout', 'The machine did not open the session in time.');
		});
		return session;
	}

	return {
		/**
		 * A session was asked for; the agent has `agentWaitMs` to open its
		 * socket. `onEnded` hears how it ended (for the audit log).
		 */
		start(record: SessionRecord, onEnded: (session: EndedSession) => void): void {
			const session = track(record, onEnded, undefined);
			later(session, 'browser', limits.noBrowserMs, () => {
				end(record.id, 'no-browser', 'No browser was connected for 60 seconds.');
			});
			watchIdle(session);
		},

		/**
		 * A session whose other end is the server itself (files). Its owner
		 * ends it (with `end`) when it is no longer used.
		 */
		startLocal(
			record: SessionRecord,
			onEnded: (session: EndedSession) => void,
			local: LocalEnd
		): void {
			track(record, onEnded, local);
		},

		/** Sends to a local session's agent; false before it is connected or once it has ended. */
		toAgent(sessionId: string, message: string | Uint8Array): boolean {
			const session = live(sessionId);
			const peer = session?.agent.peer;
			if (session?.local === undefined || peer === undefined) {
				return false;
			}
			session.lastInputAt = Date.now();
			if (typeof message === 'string') {
				peer.sendText(message);
			} else {
				session.bytesIn += message.byteLength;
				peer.sendBytes(message, () => undefined);
			}
			return true;
		},

		/** A single-use ticket for this person's browser to (re)attach, or undefined. */
		issueBrowserTicket(sessionId: string, userId: string): string | undefined {
			const session = live(sessionId);
			if (session?.userId !== userId || session.local !== undefined) {
				return undefined;
			}
			const now = Date.now();
			for (const [ticket, entry] of tickets) {
				if (entry.expiresAt < now) {
					tickets.delete(ticket);
				}
			}
			const ticket = randomBytes(32).toString('base64url');
			tickets.set(ticket, { sessionId, userId, expiresAt: now + limits.browserTicketMs });
			return ticket;
		},

		/** Uses up a browser ticket; the session it opens, if it is still good. */
		redeemBrowserTicket(sessionId: string, ticket: string): boolean {
			const entry = tickets.get(ticket);
			tickets.delete(ticket);
			return (
				entry?.sessionId === sessionId && entry.expiresAt >= Date.now() && sessions.has(sessionId)
			);
		},

		attachAgent(sessionId: string, machineId: string, peer: RelayPeer): Attach {
			const session = live(sessionId);
			if (session?.machineId !== machineId) {
				return { kind: 'refused', message: 'No such session for this machine.' };
			}
			const handover = session.record.kind === 'desktop';
			const previous = session.agent.peer;
			if (previous !== undefined && !handover) {
				return { kind: 'refused', message: 'This session is already connected.' };
			}
			// A desktop session moves to the machine's newer socket (the Windows
			// helper in another console session); the browser greets it afresh.
			previous?.close(CLOSE_REPLACED, 'Handed over to a newer connection');
			if (handover) {
				session.earlyInput = [];
			}
			session.agent = { peer, waiting: 0, paused: false };
			cancel(session, 'agent');
			for (const input of session.earlyInput) {
				forward(session.agent, session.browser, input);
			}
			session.earlyInput = [];
			sendControl(session.browser.peer, { type: 'ready' });
			session.local?.ready();
			return { kind: 'attached' };
		},

		/** Attaches a browser (after `redeemBrowserTicket`); an earlier browser is let go. */
		attachBrowser(sessionId: string, peer: RelayPeer): Attach {
			const session = live(sessionId);
			if (session === undefined || session.local !== undefined) {
				return { kind: 'refused', message: 'This session has ended.' };
			}
			const previous = session.browser.peer;
			if (previous !== undefined) {
				previous.close(CLOSE_REPLACED, 'Opened in another window');
			}
			if (session.agent.paused) {
				session.agent.paused = false;
				session.agent.peer?.resume();
			}
			session.browser = { peer, waiting: 0, paused: false };
			cancel(session, 'browser');
			const replay = session.ring.contents();
			sendControl(peer, { type: 'attached', resumed: session.everAttached });
			session.everAttached = true;
			if (replay.byteLength > 0) {
				forward(session.browser, session.agent, replay);
			}
			if (session.agent.peer !== undefined) {
				sendControl(peer, { type: 'ready' });
			}
			return { kind: 'attached' };
		},

		fromAgent(sessionId: string, peer: RelayPeer, data: Uint8Array): void {
			const session = live(sessionId);
			if (session?.agent.peer !== peer) {
				return;
			}
			session.bytesOut += data.byteLength;
			if (session.local !== undefined) {
				session.local.bytes(data);
				return;
			}
			if (session.record.kind !== 'desktop') {
				session.ring.push(data);
			}
			forward(session.browser, session.agent, data);
		},

		agentText(sessionId: string, peer: RelayPeer, text: string): void {
			const session = live(sessionId);
			if (session?.agent.peer !== peer) {
				return;
			}
			const parsed = agentSessionEventSchema.safeParse(parseJson(text));
			if (!parsed.success) {
				if (session.local !== undefined) {
					session.local.text(text);
				} else if (session.record.kind === 'desktop') {
					session.bytesOut += text.length;
					session.browser.peer?.sendText(text);
				}
				return;
			}
			switch (parsed.data.type) {
				case 'ended':
					end(sessionId, parsed.data.reason, desktopEndedMessage(parsed.data.reason));
					return;
				case 'exited':
					end(sessionId, 'exited', `The shell exited with code ${parsed.data.code}.`);
					return;
				case 'failed':
					end(sessionId, 'failed', parsed.data.message);
					return;
				case 'exec-done':
					// Terminal sessions never send it; exec sessions arrive with MCP.
					return;
			}
		},

		agentClosed(sessionId: string, peer: RelayPeer): void {
			const session = live(sessionId);
			if (session?.agent.peer !== peer) {
				return;
			}
			if (session.record.kind !== 'desktop' || session.local !== undefined) {
				end(sessionId, 'agent-lost', 'The connection to the machine was lost.');
				return;
			}
			session.agent = { peer: undefined, waiting: 0, paused: false };
			later(session, 'agent', limits.agentHandoverMs, () => {
				end(sessionId, 'agent-lost', 'The connection to the machine was lost.');
			});
		},

		/** The agent would not start the session (its `session-refused`). */
		refusedByAgent(sessionId: string, machineId: string, message: string): void {
			if (live(sessionId)?.machineId === machineId) {
				end(sessionId, 'refused', message);
			}
		},

		fromBrowser(sessionId: string, peer: RelayPeer, data: Uint8Array): void {
			const session = live(sessionId);
			if (session?.browser.peer !== peer) {
				return;
			}
			session.bytesIn += data.byteLength;
			session.lastInputAt = Date.now();
			if (session.agent.peer === undefined) {
				const held = session.earlyInput.reduce((sum, chunk) => sum + chunk.byteLength, 0);
				if (held + data.byteLength <= limits.earlyInputBytes) {
					session.earlyInput.push(data);
				}
				return;
			}
			forward(session.agent, session.browser, data);
		},

		browserText(sessionId: string, peer: RelayPeer, text: string): void {
			const session = live(sessionId);
			if (session?.browser.peer !== peer) {
				return;
			}
			const parsed = browserControlSchema.safeParse(parseJson(text));
			if (!parsed.success) {
				if (session.record.kind === 'desktop') {
					// The viewer's own messages (hello, acks, input) are the agent's to read.
					session.bytesIn += text.length;
					session.lastInputAt = Date.now();
					session.agent.peer?.sendText(text);
				}
				return;
			}
			switch (parsed.data.type) {
				case 'resize':
					session.agent.peer?.sendText(
						JSON.stringify({ type: 'resize', cols: parsed.data.cols, rows: parsed.data.rows })
					);
					return;
				case 'end':
					end(sessionId, 'closed', 'The session was ended from the console.');
					return;
			}
		},

		/** The browser went away (a reload, a lost connection or a closed tab): it has a minute. */
		browserClosed(sessionId: string, peer: RelayPeer): void {
			const session = live(sessionId);
			if (session?.browser.peer !== peer) {
				return;
			}
			session.browser = { peer: undefined, waiting: 0, paused: false };
			if (session.agent.paused) {
				session.agent.paused = false;
				session.agent.peer?.resume();
			}
			later(session, 'browser', limits.noBrowserMs, () => {
				end(sessionId, 'no-browser', 'No browser was connected for 60 seconds.');
			});
		},

		end,

		/** Who is using this machine now (T8). */
		inUse(machineId: string): SessionInUse[] {
			return [...sessions.values()]
				.filter((session) => session.machineId === machineId)
				.map((session): SessionInUse => {
					const record = session.record;
					switch (record.kind) {
						case 'terminal':
						case 'files':
							return { kind: record.kind, userName: record.userName };
						case 'desktop':
							return { kind: 'desktop', mode: record.mode, userName: record.userName };
					}
				});
		},

		/** How a recently ended session ended, for a page that comes back to it. */
		endedSession(sessionId: string): EndedSession | undefined {
			return ended.get(sessionId);
		},

		isRunning(sessionId: string): boolean {
			return sessions.has(sessionId);
		},

		/** Running sessions this person opened. */
		countFor(userId: string): number {
			return [...sessions.values()].filter((session) => session.userId === userId).length;
		}
	};
}

/** What the viewer is told when the agent ends a desktop session. */
function desktopEndedMessage(reason: SessionEndReason): string {
	switch (reason) {
		case 'closed':
			return 'The session was ended.';
		case 'disconnected-at-machine':
			return 'Someone at the machine pressed Disconnect.';
		case 'too-many-sessions':
			return 'This machine already has 4 desktop sessions open. Try again when one ends.';
		case 'agent-lost':
			return 'The machine stopped sending its screen.';
		case 'declined':
		case 'timed-out':
		case 'permission-removed':
		case 'no-browser':
		case 'exited':
		case 'failed':
		case 'refused':
		case 'idle':
		case 'agent-timeout':
		case 'unused':
		case 'server-restarted':
			return `${endReasonLabel(reason)}.`;
	}
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/**
 * The server's relay. Kept on globalThis: the dev server can load this
 * module more than once (socket routes and pages through different module
 * runners), and every copy must see the same sessions.
 */
const RELAY_KEY = Symbol.for('bmuster.session-relay');

export function sessionRelay(): Relay {
	const existing: unknown = Reflect.get(globalThis, RELAY_KEY);
	if (isRelay(existing)) {
		return existing;
	}
	const created = createRelay(RELAY_LIMITS);
	Reflect.set(globalThis, RELAY_KEY, created);
	return created;
}

function isRelay(value: unknown): value is Relay {
	return (
		typeof value === 'object' &&
		value !== null &&
		'start' in value &&
		typeof value.start === 'function' &&
		'attachAgent' in value &&
		typeof value.attachAgent === 'function'
	);
}
