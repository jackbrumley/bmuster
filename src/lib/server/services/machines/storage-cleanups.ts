import { and, eq, isNull } from 'drizzle-orm';
import {
	cleanupAuditDetail,
	cleanupStartDetail,
	type CleanupItemId,
	type CleanupRun
} from '#lib/domain/storage/cleanup.ts';
import type { Queryable } from '../../database/connection.ts';
import { machines, storageCleanups } from '../../database/schema.ts';
import { recordAudit } from '../audit/audit.ts';

/**
 * Each storage clean-up (SPEC-STORAGE 11.5): recorded and audited when it starts, and its result
 * recorded and audited once, by whichever comes first of the Storage tab and the next check-in.
 */

/** A clean-up the machine accepted: its row and the `storage-cleanup-started` entry. */
export function recordCleanupStart(
	database: Queryable,
	run: { runId: string; machineId: string; userId: string; items: readonly CleanupItemId[] },
	now: number
): void {
	database
		.insert(storageCleanups)
		.values({
			id: run.runId,
			machineId: run.machineId,
			userId: run.userId,
			items: JSON.stringify(run.items),
			requestedAt: new Date(now)
		})
		.run();
	recordAudit(
		database,
		{
			actor: { kind: 'user', userId: run.userId },
			kind: 'storage-cleanup-started',
			target: machineName(database, run.machineId),
			machineId: run.machineId,
			detail: cleanupStartDetail(run.items)
		},
		now
	);
}

function machineName(database: Queryable, machineId: string): string {
	const row = database
		.select({ name: machines.name })
		.from(machines)
		.where(eq(machines.id, machineId))
		.get();
	if (row === undefined) {
		throw new Error(`storage clean-up for unknown machine ${machineId}`);
	}
	return row.name;
}

/**
 * Records a run's result once, with its `storage-cleanup` entry in the name of the person who
 * started it. Only a run of this machine that is not recorded yet changes anything: a repeat, a
 * run still going, or a run id of another machine is left alone. True when it was recorded.
 */
export function recordCleanupResult(
	database: Queryable,
	machineId: string,
	run: CleanupRun,
	now: number
): boolean {
	if (run.kind !== 'finished' && run.kind !== 'interrupted') {
		return false;
	}
	const recorded = database
		.update(storageCleanups)
		.set({
			finishedAt: new Date(run.kind === 'finished' ? run.finishedAtMs : now),
			outcome: JSON.stringify({ kind: run.kind, items: run.items })
		})
		.where(
			and(
				eq(storageCleanups.id, run.runId),
				eq(storageCleanups.machineId, machineId),
				isNull(storageCleanups.finishedAt)
			)
		)
		.returning({ userId: storageCleanups.userId })
		.all()[0];
	if (recorded === undefined) {
		return false;
	}
	recordAudit(
		database,
		{
			actor: { kind: 'user', userId: recorded.userId },
			kind: 'storage-cleanup',
			target: machineName(database, machineId),
			machineId,
			detail: cleanupAuditDetail(run.items, run.kind)
		},
		now
	);
	return true;
}
