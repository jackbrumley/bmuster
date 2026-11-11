import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { lowDiskAlerts, type ReportedStorage } from '#lib/domain/storage/storage.ts';
import { formatBytes } from '#lib/utils/format.ts';
import { storedDrivesSchema, type StorageReport } from '#lib/schemas/storage/storage.ts';
import type { Queryable } from '../../database/connection.ts';
import { machineStorage, machines } from '../../database/schema.ts';
import { raiseNotification } from '../notifications/events.ts';
import { recordCleanupResult } from './storage-cleanups.ts';

/**
 * Each machine's per-drive storage summary (SPEC-STORAGE 6): size, free space and scan freshness
 * from the latest check-in, replaced as a set. Folder names never reach the server this way;
 * they stay on the machine and are read live by people with `files`.
 */

const alertedSchema = z.array(z.string());

/**
 * The check-in's `storage`. An agent that does not report it leaves the last one alone. A drive
 * that reaches 90 % raises Disk nearly full once (SPEC-STORAGE 12), and the last clean-up's
 * result is recorded if it is new (SPEC-STORAGE 11.4).
 */
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
			const before = database
				.select({ lowDiskAlerted: machineStorage.lowDiskAlerted })
				.from(machineStorage)
				.where(eq(machineStorage.machineId, machineId))
				.get();
			const alerts = lowDiskAlerts(
				report.drives,
				alertedSchema.parse(JSON.parse(before?.lowDiskAlerted ?? '[]'))
			);
			const row = {
				drives: JSON.stringify(report.drives),
				reportedAt: new Date(now),
				lowDiskAlerted: JSON.stringify(alerts.alerted)
			};
			database
				.insert(machineStorage)
				.values({ machineId, ...row })
				.onConflictDoUpdate({ target: machineStorage.machineId, set: row })
				.run();
			if (alerts.raise.length > 0) {
				const machine = database
					.select({ name: machines.name, hostname: machines.hostname })
					.from(machines)
					.where(eq(machines.id, machineId))
					.get();
				if (machine === undefined) {
					throw new Error(`storage report for unknown machine ${machineId}`);
				}
				for (const drive of alerts.raise) {
					raiseNotification(
						database,
						{
							kind: 'disk-nearly-full',
							machineId,
							detail: {
								machineName: machine.name,
								hostname: machine.hostname,
								drive: drive.mount,
								used: `${drive.percent} %`,
								free: formatBytes(drive.freeBytes)
							}
						},
						now
					);
				}
			}
			recordCleanupResult(database, machineId, report.cleanup, now);
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
