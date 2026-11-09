import { and, asc, desc, eq, gt, gte, inArray, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import {
	levelsAtOrAbove,
	type AgentLogRecordView,
	type LogLevel,
	type LogPage,
	type LogSource,
	type ServerLogRecordView
} from '#lib/domain/logs/logs.ts';
import type { Queryable } from '../../database/connection.ts';
import { agentLogRecords, serverLogRecords } from '../../database/schema.ts';

/**
 * Reading stored log records (SPEC-AGENT-LOGS 4), newest first by their own time. A cursor is
 * opaque to callers: `o-<atMs>-<rowid>` pages back in time, `n-<rowid>` follows records stored
 * after an earlier read (by arrival, so a backlog that arrives late is not missed).
 */
export type LogCursor =
	| { kind: 'none' }
	| { kind: 'older'; atMs: number; rowid: number }
	| { kind: 'newer'; rowid: number };

const LOG_CURSOR_PATTERN = /^(o-\d{1,15}-\d{1,15}|n-\d{1,15})$/;

export function parseLogCursor(text: string | null): LogCursor {
	if (text === null || !LOG_CURSOR_PATTERN.test(text)) {
		return { kind: 'none' };
	}
	const [kind, first, second] = text.split('-');
	return kind === 'o'
		? { kind: 'older', atMs: Number(first), rowid: Number(second) }
		: { kind: 'newer', rowid: Number(first) };
}

type Window = { sinceMs: number | null; untilMs: number | null; level: LogLevel | null };

export type AgentLogQuery = Window & {
	machineId: string;
	source: LogSource | null;
	cursor: LogCursor;
	limit: number;
};

export type ServerLogQuery = Window & {
	area: string | null;
	cursor: LogCursor;
	limit: number;
};

type Columns = {
	at: typeof agentLogRecords.at | typeof serverLogRecords.at;
	level: typeof agentLogRecords.level | typeof serverLogRecords.level;
};

const rowid = sql<number>`rowid`;

function windowConditions(columns: Columns, window: Window): SQL[] {
	const conditions: SQL[] = [];
	if (window.sinceMs !== null) conditions.push(gte(columns.at, new Date(window.sinceMs)));
	if (window.untilMs !== null) conditions.push(lte(columns.at, new Date(window.untilMs)));
	if (window.level !== null) conditions.push(inArray(columns.level, levelsAtOrAbove(window.level)));
	return conditions;
}

function cursorCondition(columns: Columns, cursor: LogCursor): SQL | undefined {
	switch (cursor.kind) {
		case 'none':
			return undefined;
		case 'older': {
			const at = new Date(cursor.atMs);
			return or(lt(columns.at, at), and(eq(columns.at, at), lt(rowid, cursor.rowid)));
		}
		case 'newer':
			return gt(rowid, cursor.rowid);
	}
}

type Row = { rowid: number; at: Date };

/** Newest first; `older` when there may be more; `newer` follows from here. */
function pageOf<R extends Row, V>(
	rows: R[],
	query: { cursor: LogCursor; limit: number },
	latestRowid: number,
	view: (row: R) => V
): LogPage<V> {
	const more = rows.length > query.limit;
	const kept = rows.slice(0, query.limit);
	if (query.cursor.kind === 'newer') {
		// Read oldest-arrival first, so a burst larger than the limit is followed in order.
		const last = kept.at(-1);
		const sorted = [...kept].sort((a, b) => b.at.getTime() - a.at.getTime() || b.rowid - a.rowid);
		return {
			records: sorted.map(view),
			older: { kind: 'none' },
			newer: `n-${last === undefined ? query.cursor.rowid : last.rowid}`
		};
	}
	const oldest = kept.at(-1);
	return {
		records: kept.map(view),
		older:
			more && oldest !== undefined
				? { kind: 'cursor', cursor: `o-${oldest.at.getTime()}-${oldest.rowid}` }
				: { kind: 'none' },
		newer: `n-${latestRowid}`
	};
}

function latest(
	database: Queryable,
	table: typeof agentLogRecords | typeof serverLogRecords
): number {
	return (
		database
			.select({ max: sql<number | null>`max(rowid)` })
			.from(table)
			.get()?.max ?? 0
	);
}

export function readAgentLogs(
	database: Queryable,
	query: AgentLogQuery
): LogPage<AgentLogRecordView> {
	const conditions = [
		eq(agentLogRecords.machineId, query.machineId),
		...windowConditions(agentLogRecords, query)
	];
	if (query.source !== null) conditions.push(eq(agentLogRecords.source, query.source));
	const cursor = cursorCondition(agentLogRecords, query.cursor);
	if (cursor !== undefined) conditions.push(cursor);
	const latestRowid = latest(database, agentLogRecords);
	const rows = database
		.select({
			rowid,
			instance: agentLogRecords.instance,
			seq: agentLogRecords.seq,
			at: agentLogRecords.at,
			level: agentLogRecords.level,
			source: agentLogRecords.source,
			target: agentLogRecords.target,
			text: agentLogRecords.text
		})
		.from(agentLogRecords)
		.where(and(...conditions))
		.orderBy(
			...(query.cursor.kind === 'newer' ? [asc(rowid)] : [desc(agentLogRecords.at), desc(rowid)])
		)
		.limit(query.limit + 1)
		.all();
	return pageOf(rows, query, latestRowid, (row) => ({
		instance: row.instance,
		seq: row.seq,
		atIso: row.at.toISOString(),
		level: row.level,
		source: row.source,
		target: row.target,
		text: row.text
	}));
}

export function readServerLogs(
	database: Queryable,
	query: ServerLogQuery
): LogPage<ServerLogRecordView> {
	const conditions = windowConditions(serverLogRecords, query);
	if (query.area !== null) conditions.push(eq(serverLogRecords.area, query.area));
	const cursor = cursorCondition(serverLogRecords, query.cursor);
	if (cursor !== undefined) conditions.push(cursor);
	const latestRowid = latest(database, serverLogRecords);
	const rows = database
		.select({
			rowid,
			instance: serverLogRecords.instance,
			seq: serverLogRecords.seq,
			at: serverLogRecords.at,
			level: serverLogRecords.level,
			area: serverLogRecords.area,
			machineId: serverLogRecords.machineId,
			text: serverLogRecords.text
		})
		.from(serverLogRecords)
		.where(conditions.length === 0 ? undefined : and(...conditions))
		.orderBy(
			...(query.cursor.kind === 'newer' ? [asc(rowid)] : [desc(serverLogRecords.at), desc(rowid)])
		)
		.limit(query.limit + 1)
		.all();
	return pageOf(rows, query, latestRowid, (row) => ({
		instance: row.instance,
		seq: row.seq,
		atIso: row.at.toISOString(),
		level: row.level,
		area: row.area,
		machineId: row.machineId,
		text: row.text
	}));
}
