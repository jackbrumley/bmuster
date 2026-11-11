import { eq } from 'drizzle-orm';
import type { ReportedStorage } from '#lib/domain/storage/storage.ts';
import { storedDrivesSchema, type StorageReport } from '#lib/schemas/storage/storage.ts';
import type { Queryable } from '../../database/connection.ts';
import { machineStorage } from '../../database/schema.ts';

/**
 * Each machine's per-drive storage summary (SPEC-STORAGE 6): size, free space and scan freshness
 * from the latest check-in, replaced as a set. Folder names never reach the server this way;
 * they stay on the machine and are read live by people with `files`.
 */

/** The check-in's `storage`. An agent that does not report it leaves the last one alone. */
export function storeCheckInStorage(
	database: Queryable,
	machineId: string,
	report: StorageReport,
	now: number
): void {
	switch (report.kind) {
		case 'unreported':
			return;
		case 'reported': {
			const row = { drives: JSON.stringify(report.drives), reportedAt: new Date(now) };
			database
				.insert(machineStorage)
				.values({ machineId, ...row })
				.onConflictDoUpdate({ target: machineStorage.machineId, set: row })
				.run();
			return;
		}
	}
}

/** The last summary the machine reported. A row the server cannot read is an error, not "none". */
export function reportedStorage(database: Queryable, machineId: string): ReportedStorage {
	const row = database
		.select()
		.from(machineStorage)
		.where(eq(machineStorage.machineId, machineId))
		.get();
	if (row === undefined) {
		return { kind: 'none' };
	}
	const drives = storedDrivesSchema.parse(JSON.parse(row.drives));
	return { kind: 'reported', drives, reportedAt: row.reportedAt.toISOString() };
}
