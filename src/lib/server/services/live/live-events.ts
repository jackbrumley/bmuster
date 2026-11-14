import type { LiveEvent } from '#lib/domain/commands/assistant-runs.ts';
import { LIVE_EVENT } from '#lib/schemas/commands/approvals.ts';
import type { ConsoleUser } from '#lib/domain/users/user.ts';
import type { Queryable } from '../../database/connection.ts';
import { authenticateSession } from '../auth/current-user.ts';

/**
 * The console's live channel (`GET /api/live`, SPEC-MCP 10.3): one stream per open console tab,
 * as server-sent events. Whoever publishes says, for each person listening, what that person may
 * hear: nothing, or an event written for them (an approval request goes only to people who may
 * decide it). The session is checked again on every event. Generic, so later features reuse it.
 */

/** What one person hears of a change: an event for them, or nothing. */
export type LiveAudience = (user: ConsoleUser) => LiveEvent | undefined;

type Listener = (audience: LiveAudience) => void;

/** Kept on globalThis like the runner: the dev server can load this module more than once. */
const LISTENERS_KEY = Symbol.for('bmuster.live-listeners');

function isListeners(value: unknown): value is Set<Listener> {
	return value instanceof Set;
}

function listeners(): Set<Listener> {
	const existing: unknown = Reflect.get(globalThis, LISTENERS_KEY);
	if (isListeners(existing)) {
		return existing;
	}
	const created = new Set<Listener>();
	Reflect.set(globalThis, LISTENERS_KEY, created);
	return created;
}

/** Tells every open console what it may hear of a change. */
export function publishLive(audience: LiveAudience): void {
	for (const listener of listeners()) {
		listener(audience);
	}
}

/** Listens until the returned function is called. */
export function onLive(listener: Listener): () => void {
	const all = listeners();
	all.add(listener);
	return () => {
		all.delete(listener);
	};
}

const KEEP_ALIVE_MS = 25_000;
const RETRY_MS = 5_000;

/** One console tab's stream, for the person whose session cookie is `token`. */
export function liveStream(
	database: Queryable,
	token: string,
	clock: () => number
): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	let stop = (): void => undefined;
	return new ReadableStream<Uint8Array>({
		start(controller) {
			let open = true;
			const write = (text: string): void => {
				if (open) {
					controller.enqueue(encoder.encode(text));
				}
			};
			const unsubscribe = onLive((audience) => {
				const user = authenticateSession(database, token, clock());
				if (user === undefined) {
					stop();
					controller.close();
					return;
				}
				const event = audience(user);
				if (event !== undefined) {
					write(`event: ${LIVE_EVENT}\ndata: ${JSON.stringify(event)}\n\n`);
				}
			});
			const keepAlive = setInterval(() => {
				write(': keep-alive\n\n');
			}, KEEP_ALIVE_MS);
			keepAlive.unref();
			stop = () => {
				open = false;
				unsubscribe();
				clearInterval(keepAlive);
			};
			write(`retry: ${String(RETRY_MS)}\n\n`);
		},
		cancel() {
			stop();
		}
	});
}
