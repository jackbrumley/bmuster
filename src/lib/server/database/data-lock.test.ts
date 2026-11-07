import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireDataLock, lockPathFor } from './data-lock.ts';

const folders: string[] = [];

function scratchDatabase(): string {
	const folder = mkdtempSync(join(tmpdir(), 'bmuster-lock-'));
	folders.push(folder);
	return join(folder, 'bmuster.db');
}

afterEach(() => {
	for (const folder of folders.splice(0)) {
		rmSync(folder, { recursive: true, force: true });
	}
});

function quiet(lines: string[]): (line: string) => void {
	return (line) => lines.push(line);
}

describe('data lock (SPEC-HOSTING H2)', () => {
	it('H2: is a file beside the database', () => {
		expect(lockPathFor('/data/bmuster.db')).toBe('/data/bmuster.db.lock');
	});

	it('H2: takes a free lock at once, without waiting', async () => {
		const database = scratchDatabase();
		const lines: string[] = [];
		const lock = await acquireDataLock(database, {
			timeoutMs: 1_000,
			retryMs: 10,
			log: quiet(lines)
		});
		expect(lock.path).toBe(`${database}.lock`);
		expect(lines).toEqual([]);
		lock.release();
	});

	it('H2: a second server waits, says why, and gets the lock when the first lets go', async () => {
		const database = scratchDatabase();
		const first = await acquireDataLock(database, {
			timeoutMs: 1_000,
			retryMs: 10,
			log: quiet([])
		});
		const lines: string[] = [];
		const second = acquireDataLock(database, { timeoutMs: 5_000, retryMs: 10, log: quiet(lines) });
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain(`another server is using ${database}`);
		first.release();
		const lock = await second;
		expect(lines[1]).toContain('the other server has stopped');
		lock.release();
	});

	it('H2: gives up after the timeout with the reason', async () => {
		const database = scratchDatabase();
		const first = await acquireDataLock(database, {
			timeoutMs: 1_000,
			retryMs: 10,
			log: quiet([])
		});
		await expect(
			acquireDataLock(database, { timeoutMs: 100, retryMs: 10, log: quiet([]) })
		).rejects.toThrow(
			/Another BMuster server is still using .* Only one server may use a database/
		);
		first.release();
	});

	it('H2: is an operating-system lock, held by another process until it exits', async () => {
		const database = scratchDatabase();
		// Another Node process takes the lock the same way, then waits to be killed
		// (the interval keeps its connection referenced, so it is never collected).
		const holder = spawn(
			process.execPath,
			[
				'--input-type=module',
				'-e',
				`import Database from 'better-sqlite3';
				 const client = new Database(${JSON.stringify(lockPathFor(database))});
				 client.pragma('locking_mode = EXCLUSIVE');
				 client.exec('BEGIN EXCLUSIVE');
				 process.stdout.write('held\\n');
				 setInterval(() => client.open, 1000);`
			],
			{ stdio: ['ignore', 'pipe', 'inherit'] }
		);
		const exited = new Promise((resolve) => {
			holder.once('exit', resolve);
		});
		try {
			await new Promise<void>((resolve) => {
				holder.stdout.once('data', () => {
					resolve();
				});
			});
			await expect(
				acquireDataLock(database, { timeoutMs: 200, retryMs: 20, log: quiet([]) })
			).rejects.toThrow('Another BMuster server');
		} finally {
			// Killed, not stopped: the kernel must release the lock of a process that never cleaned up.
			holder.kill('SIGKILL');
			await exited;
		}
		const lock = await acquireDataLock(database, { timeoutMs: 1_000, retryMs: 20, log: quiet([]) });
		expect(lock.path).toBe(lockPathFor(database));
		lock.release();
	});
});
