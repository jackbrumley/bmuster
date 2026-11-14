import { MAX_RECORD_TEXT } from '#lib/domain/logs/logs.ts';
import type { Queryable } from '../../database/connection.ts';
import { serverLogRecords } from '../../database/schema.ts';

/**
 * The server's own log (SPEC-AGENT-LOGS 2). Every record goes to standard output (warnings and
 * errors to standard error), as before; once `storeServerLogs` has run at start-up, records are
 * also kept in `server_log_records` with their area and, where known, the machine, so admins and
 * diagnostics tokens can read them. Secrets are never written here: the first-run setup code
 * prints with `printToServerLog` instead, which is never stored.
 */
export type ServerLogLevel = 'info' | 'warn' | 'error';

export type ServerLogArea =
	| 'server'
	| 'http'
	| 'database'
	| 'agents'
	| 'sessions'
	| 'relay'
	| 'updates'
	| 'auth'
	| 'oauth'
	| 'email'
	| 'logs';

type Store =
	{ kind: 'none' } | { kind: 'database'; database: Queryable; instance: string; seq: number };

const STATE_KEY = Symbol.for('bmuster.server-log');

function isStore(value: unknown): value is { store: Store } {
	return typeof value === 'object' && value !== null && 'store' in value;
}

/** Shared through globalThis, so the dev server's module reloads keep one store and sequence. */
function state(): { store: Store } {
	const existing: unknown = Reflect.get(globalThis, STATE_KEY);
	if (isStore(existing)) {
		return existing;
	}
	const created: { store: Store } = { store: { kind: 'none' } };
	Reflect.set(globalThis, STATE_KEY, created);
	return created;
}

/** Start-up: keep records from now on, numbered within this server process. */
export function storeServerLogs(database: Queryable, instance: string): void {
	state().store = { kind: 'database', database, instance, seq: 0 };
}

/** Tests: back to standard output only. */
export function stopStoringServerLogs(): void {
	state().store = { kind: 'none' };
}

function cut(text: string): string {
	if (text.length <= MAX_RECORD_TEXT) {
		return text;
	}
	const marker = ` [cut ${text.length} characters]`;
	return `${text.slice(0, MAX_RECORD_TEXT - marker.length)}${marker}`;
}

export function serverLog(
	level: ServerLogLevel,
	area: ServerLogArea,
	text: string,
	machineId: string | null = null,
	now: number = Date.now()
): void {
	const line = `[${area}] ${text}\n`;
	if (level === 'info') {
		process.stdout.write(line);
	} else {
		process.stderr.write(line);
	}
	const store = state().store;
	if (store.kind === 'none') {
		return;
	}
	store.seq += 1;
	try {
		store.database
			.insert(serverLogRecords)
			.values({
				instance: store.instance,
				seq: store.seq,
				at: new Date(now),
				level,
				area,
				machineId,
				text: cut(text)
			})
			.run();
	} catch (error) {
		// Not through serverLog: a failing store must not recurse.
		process.stderr.write(`[logs] Could not store a server log record: ${String(error)}\n`);
	}
}

/** A `(line) => void` writer for start-up helpers that take one. */
export function serverLogWriter(area: ServerLogArea): (line: string) => void {
	return (line) => {
		serverLog('info', area, line);
	};
}
