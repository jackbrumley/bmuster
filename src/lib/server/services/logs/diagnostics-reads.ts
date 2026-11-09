import { eq } from 'drizzle-orm';
import type {
	AgentLogRecordView,
	LogLevel,
	LogPage,
	LogSource,
	ServerLogRecordView
} from '#lib/domain/logs/logs.ts';
import type { Machine } from '#lib/domain/machines/machine.ts';
import { inventorySchema, type InventoryWire } from '#lib/schemas/agents/agent-protocol.ts';
import type { AppDatabase, Queryable } from '../../database/connection.ts';
import { machineInventory, machines } from '../../database/schema.ts';
import type { ReleaseLookup } from '../agents/releases.ts';
import { recordAudit } from '../audit/audit.ts';
import { findMachine, listMachines } from '../machines/machine-views.ts';
import { parseLogCursor, readAgentLogs, readServerLogs, type LogCursor } from './log-queries.ts';
import { verboseUntil } from './verbose.ts';

/**
 * What the diagnostics endpoints read (SPEC-AGENT-LOGS 4), for signed-in admins and diagnostics
 * tokens alike. Log reads are audited with the source, filter and record count, never the
 * contents; following new records with a `newer` cursor (the Live toggle) is not audited again.
 */
export type Reader = { userId: string; via: string };

export type LogFilter = {
	since: string | null;
	until: string | null;
	level: LogLevel | null;
	cursor: string | null;
	limit: number;
};

export type DiagnosticsMachine = {
	id: string;
	name: string;
	osFamily: Machine['osFamily'];
	agentVersion: string;
	online: boolean;
	lastSeenIso: string;
};

export function diagnosticsMachines(
	database: AppDatabase,
	now: number,
	releases: ReleaseLookup
): DiagnosticsMachine[] {
	return listMachines(database, now, releases).map((machine) => ({
		id: machine.id,
		name: machine.name,
		osFamily: machine.osFamily,
		agentVersion: machine.agentVersion,
		online: machine.status.kind === 'online',
		lastSeenIso: machine.lastSeenIso
	}));
}

export type MachineReport = {
	machine: Machine;
	/** The latest full inventory exactly as the agent sent it; null before the first. */
	inventory: InventoryWire | null;
	verboseUntilIso: string | null;
};

export function machineReport(
	database: AppDatabase,
	machineId: string,
	now: number,
	releases: ReleaseLookup
): MachineReport | undefined {
	const machine = findMachine(database, machineId, now, releases);
	if (machine === undefined) {
		return undefined;
	}
	const row = database
		.select({ data: machineInventory.data })
		.from(machineInventory)
		.where(eq(machineInventory.machineId, machineId))
		.get();
	const until = verboseUntil(database, machineId, now);
	return {
		machine,
		inventory: row === undefined ? null : inventorySchema.parse(JSON.parse(row.data)),
		verboseUntilIso: until === null ? null : new Date(until).toISOString()
	};
}

function windowOf(filter: LogFilter): {
	sinceMs: number | null;
	untilMs: number | null;
	cursor: LogCursor;
} {
	return {
		sinceMs: filter.since === null ? null : Date.parse(filter.since),
		untilMs: filter.until === null ? null : Date.parse(filter.until),
		cursor: parseLogCursor(filter.cursor)
	};
}

function filterDetail(filter: LogFilter, records: number, reader: Reader): Record<string, string> {
	return {
		level: filter.level ?? 'all',
		since: filter.since ?? 'any',
		until: filter.until ?? 'any',
		records: String(records),
		via: reader.via
	};
}

/** A machine's records, removed machines included while their records last. */
export function readMachineLogs(
	database: Queryable,
	reader: Reader,
	machineId: string,
	filter: LogFilter & { source: LogSource | null },
	now: number
): LogPage<AgentLogRecordView> | undefined {
	const machine = database
		.select({ name: machines.name })
		.from(machines)
		.where(eq(machines.id, machineId))
		.get();
	if (machine === undefined) {
		return undefined;
	}
	const window = windowOf(filter);
	const page = readAgentLogs(database, {
		machineId,
		...window,
		level: filter.level,
		source: filter.source,
		limit: filter.limit
	});
	if (window.cursor.kind !== 'newer') {
		recordAudit(
			database,
			{
				actor: { kind: 'user', userId: reader.userId },
				kind: 'agent-logs-viewed',
				target: machine.name,
				machineId,
				detail: {
					source: filter.source ?? 'all',
					...filterDetail(filter, page.records.length, reader)
				}
			},
			now
		);
	}
	return page;
}

export function readServerLog(
	database: Queryable,
	reader: Reader,
	filter: LogFilter & { area: string | null },
	now: number
): LogPage<ServerLogRecordView> {
	const window = windowOf(filter);
	const page = readServerLogs(database, {
		...window,
		level: filter.level,
		area: filter.area,
		limit: filter.limit
	});
	if (window.cursor.kind !== 'newer') {
		recordAudit(
			database,
			{
				actor: { kind: 'user', userId: reader.userId },
				kind: 'server-logs-viewed',
				target: 'Server log',
				machineId: null,
				detail: { area: filter.area ?? 'all', ...filterDetail(filter, page.records.length, reader) }
			},
			now
		);
	}
	return page;
}
