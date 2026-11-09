import { and, eq, gt, lt, sql } from 'drizzle-orm';
import type { Queryable } from '../../database/connection.ts';
import { agentLogRecords, serverLogRecords } from '../../database/schema.ts';
import { serverLog } from './server-log.ts';

/**
 * Log retention (SPEC-AGENT-LOGS 2): seven days, at most 100 000 records per machine and
 * 200 000 server records, oldest first. Runs at start-up and every hour. Records of removed
 * machines stay until they age out like any other.
 */
export type RetentionLimits = { maxAgeMs: number; perMachine: number; server: number };

export const RETENTION: RetentionLimits = {
	maxAgeMs: 7 * 24 * 60 * 60 * 1000,
	perMachine: 100_000,
	server: 200_000
};

const EVERY_MS = 60 * 60 * 1000;

export type Pruned = { agentRecords: number; serverRecords: number };

export function pruneLogs(
	database: Queryable,
	now: number,
	limits: RetentionLimits = RETENTION
): Pruned {
	const cutoff = new Date(now - limits.maxAgeMs);
	let agentRecords = database
		.delete(agentLogRecords)
		.where(lt(agentLogRecords.at, cutoff))
		.run().changes;
	const crowded = database
		.select({ machineId: agentLogRecords.machineId })
		.from(agentLogRecords)
		.groupBy(agentLogRecords.machineId)
		.having(gt(sql`count(*)`, limits.perMachine))
		.all();
	for (const { machineId } of crowded) {
		// Everything older than the machine's newest `perMachine` records.
		agentRecords += database
			.delete(agentLogRecords)
			.where(
				and(
					eq(agentLogRecords.machineId, machineId),
					sql`rowid NOT IN (SELECT rowid FROM ${agentLogRecords} WHERE ${agentLogRecords.machineId} = ${machineId} ORDER BY ${agentLogRecords.at} DESC, rowid DESC LIMIT ${limits.perMachine})`
				)
			)
			.run().changes;
	}
	let serverRecords = database
		.delete(serverLogRecords)
		.where(lt(serverLogRecords.at, cutoff))
		.run().changes;
	serverRecords += database
		.delete(serverLogRecords)
		.where(
			sql`rowid NOT IN (SELECT rowid FROM ${serverLogRecords} ORDER BY ${serverLogRecords.at} DESC, rowid DESC LIMIT ${limits.server})`
		)
		.run().changes;
	return { agentRecords, serverRecords };
}

/** Start-up: prune now and every hour after. */
export function scheduleLogRetention(database: Queryable): void {
	const run = (): void => {
		const pruned = pruneLogs(database, Date.now());
		if (pruned.agentRecords + pruned.serverRecords > 0) {
			serverLog(
				'info',
				'logs',
				`Pruned ${pruned.agentRecords} agent and ${pruned.serverRecords} server log records.`
			);
		}
	};
	run();
	setInterval(run, EVERY_MS).unref();
}
