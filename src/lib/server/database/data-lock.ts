import Database from 'better-sqlite3';
import { setTimeout as sleep } from 'node:timers/promises';

/**
 * One server per database (SPEC-HOSTING H2). Two servers writing one SQLite
 * file would each keep their own in-memory state (live agents, setup code,
 * sessions) and race on migrations, so the second one waits.
 *
 * The lock is an operating-system file lock: SQLite's own exclusive lock on
 * a small file beside the database (`<database>.lock`), taken with
 * `locking_mode = EXCLUSIVE` and an open `BEGIN EXCLUSIVE`. SQLite uses
 * fcntl locks on Linux and LockFileEx on Windows, so the lock is released
 * by the kernel when the process ends, however it ends, and is seen across
 * containers that share the volume. No lock file is ever "stale".
 */
export type DataLock = { path: string; release(): void };

export type LockWaitOptions = {
	/** Give up after this long, with a message that says why. */
	timeoutMs: number;
	/** How often to try again while another server holds the lock. */
	retryMs: number;
	/** Where the waiting messages go (the server log). */
	log: (line: string) => void;
};

export function lockPathFor(databasePath: string): string {
	return `${databasePath}.lock`;
}

/**
 * Every lock this process holds. A connection nothing refers to is closed by
 * the garbage collector, which would silently release its lock, so the
 * module keeps them until `release`.
 */
const held = new Set<Database.Database>();

function isBusy(error: unknown): boolean {
	return (
		error instanceof Error &&
		'code' in error &&
		(error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED')
	);
}

/** Takes the lock now, or answers `held` when another process has it. */
function tryLock(path: string): { kind: 'taken'; lock: DataLock } | { kind: 'held' } {
	const client = new Database(path, { timeout: 0 });
	try {
		client.pragma('locking_mode = EXCLUSIVE');
		client.exec('BEGIN EXCLUSIVE');
	} catch (error) {
		client.close();
		if (isBusy(error)) {
			return { kind: 'held' };
		}
		throw error;
	}
	held.add(client);
	return {
		kind: 'taken',
		lock: {
			path,
			release() {
				held.delete(client);
				client.close();
			}
		}
	};
}

/**
 * Takes the lock on the database at `databasePath`, waiting while another
 * server holds it. Throws after `timeoutMs` with the reason, so the process
 * stops with a message instead of hanging unseen.
 */
export async function acquireDataLock(
	databasePath: string,
	options: LockWaitOptions
): Promise<DataLock> {
	const path = lockPathFor(databasePath);
	const started = Date.now();
	let waiting = false;
	for (;;) {
		const attempt = tryLock(path);
		if (attempt.kind === 'taken') {
			if (waiting) {
				const seconds = Math.round((Date.now() - started) / 1000);
				options.log(
					`BMuster: the other server has stopped; ${path} is ours after ${String(seconds)} s.`
				);
			}
			return attempt.lock;
		}
		const elapsed = Date.now() - started;
		if (elapsed >= options.timeoutMs) {
			throw new Error(
				`Another BMuster server is still using ${databasePath} (it holds ${path}) after ` +
					`${String(Math.round(options.timeoutMs / 1000))} s. Only one server may use a database at a time: ` +
					'stop the other one (an older container, a second service or a hand-started server), then start this one again.'
			);
		}
		if (!waiting) {
			waiting = true;
			options.log(
				`BMuster: another server is using ${databasePath} (it holds ${path}). ` +
					`Waiting up to ${String(Math.round(options.timeoutMs / 1000))} s for it to stop; ` +
					'during a rolling deploy the old container stops next.'
			);
		}
		await sleep(Math.min(options.retryMs, options.timeoutMs - elapsed));
	}
}
