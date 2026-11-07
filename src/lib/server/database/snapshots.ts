import type Database from 'better-sqlite3';
import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Nightly snapshots of the database (SPEC-HOSTING H3). A copy of the live
 * file taken by a VM or volume backup can catch SQLite half-way through a
 * write; a snapshot made with SQLite's online backup API is always whole.
 * Each night's snapshot is `backups/bmuster-YYYY-MM-DD.db` beside the
 * database; the newest `keep` are kept.
 *
 * The copy is written under a temporary name and renamed into place, so a
 * snapshot file either is complete or does not exist.
 */
export type SnapshotSchedule =
	{ kind: 'off' } | { kind: 'daily'; hour: number; minute: number; keep: number };

const SNAPSHOT_NAME = /^bmuster-\d{4}-\d{2}-\d{2}\.db$/;

export function snapshotFolderFor(databasePath: string): string {
	return join(dirname(databasePath), 'backups');
}

function twoDigits(value: number): string {
	return String(value).padStart(2, '0');
}

/** `bmuster-YYYY-MM-DD.db`, in the server's local time zone (TZ). */
export function snapshotName(at: Date): string {
	return `bmuster-${String(at.getFullYear())}-${twoDigits(at.getMonth() + 1)}-${twoDigits(at.getDate())}.db`;
}

/** Deletes all but the newest `keep` snapshots; returns the names deleted. Other files are left alone. */
export function pruneSnapshots(folder: string, keep: number): string[] {
	// The date in the name sorts the same as the calendar.
	const snapshots = readdirSync(folder)
		.filter((name) => SNAPSHOT_NAME.test(name))
		.sort();
	const doomed = snapshots.slice(0, Math.max(0, snapshots.length - keep));
	for (const name of doomed) {
		rmSync(join(folder, name));
	}
	return doomed;
}

/** Writes today's snapshot (replacing one already made today) and prunes old ones. */
export async function writeSnapshot(
	client: Database.Database,
	folder: string,
	keep: number,
	now: Date
): Promise<{ path: string; pruned: string[] }> {
	mkdirSync(folder, { recursive: true });
	const name = snapshotName(now);
	const path = join(folder, name);
	const partial = join(folder, `.${name}.partial`);
	rmSync(partial, { force: true });
	try {
		await client.backup(partial);
		renameSync(partial, path);
	} finally {
		rmSync(partial, { force: true });
	}
	return { path, pruned: pruneSnapshots(folder, keep) };
}

/** Milliseconds from `now` to the next `hour:minute` in local time (tomorrow if it has passed). */
export function delayUntilNext(now: Date, hour: number, minute: number): number {
	const next = new Date(now);
	next.setHours(hour, minute, 0, 0);
	if (next.getTime() <= now.getTime()) {
		next.setDate(next.getDate() + 1);
	}
	return next.getTime() - now.getTime();
}

/**
 * Runs `writeSnapshot` every day at the scheduled time while the process
 * lives. A failed snapshot is logged with its reason and tried again the
 * next night; it never stops the server.
 */
export function scheduleSnapshots(
	client: Database.Database,
	databasePath: string,
	schedule: SnapshotSchedule,
	log: (line: string) => void
): void {
	if (schedule.kind === 'off') {
		log('BMuster: nightly database snapshots are off (BMUSTER_BACKUP_KEEP=0).');
		return;
	}
	const { hour, minute, keep } = schedule;
	const folder = snapshotFolderFor(databasePath);
	const at = `${twoDigits(hour)}:${twoDigits(minute)}`;
	log(
		`BMuster: a database snapshot is written to ${folder} every day at ${at}, keeping ${String(keep)}.`
	);
	function arm(): void {
		const timer = setTimeout(
			() => {
				writeSnapshot(client, folder, keep, new Date())
					.then(({ path, pruned }) => {
						const removed = pruned.length > 0 ? `; removed ${pruned.join(', ')}` : '';
						log(`BMuster: database snapshot written to ${path}${removed}.`);
					})
					.catch((error: unknown) => {
						const reason = error instanceof Error ? error.message : String(error);
						log(`BMuster: the database snapshot in ${folder} failed: ${reason}`);
					})
					.finally(arm);
			},
			delayUntilNext(new Date(), hour, minute)
		);
		// The snapshot never keeps the process alive on its own.
		timer.unref();
	}
	arm();
}
