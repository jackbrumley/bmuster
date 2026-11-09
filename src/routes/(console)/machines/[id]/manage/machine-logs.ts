import {
	agentRecordLine,
	type AgentLogRecordView,
	type LogLevel,
	type LogSource
} from '#lib/domain/logs/logs.ts';

/** The Logs panel's filters and how they become a diagnostics query (SPEC-AGENT-LOGS 4). */
export type LevelChoice = Extract<LogLevel, 'debug' | 'info' | 'warn' | 'error'>;
export type SourceChoice = LogSource | 'all';
export type SpanChoice = 'hour' | 'day' | 'week';

export const LEVEL_OPTIONS: readonly { value: LevelChoice; label: string; count: undefined }[] = [
	{ value: 'debug', label: 'All', count: undefined },
	{ value: 'info', label: 'Info', count: undefined },
	{ value: 'warn', label: 'Warnings', count: undefined },
	{ value: 'error', label: 'Errors', count: undefined }
];

export const SOURCE_OPTIONS: readonly { value: SourceChoice; label: string; count: undefined }[] = [
	{ value: 'all', label: 'Everything', count: undefined },
	{ value: 'agent', label: 'Agent', count: undefined },
	{ value: 'helper', label: 'Helpers', count: undefined },
	{ value: 'journal', label: 'Journal', count: undefined }
];

export const SPAN_OPTIONS: readonly { value: SpanChoice; label: string; count: undefined }[] = [
	{ value: 'hour', label: 'Last hour', count: undefined },
	{ value: 'day', label: '24 hours', count: undefined },
	{ value: 'week', label: '7 days', count: undefined }
];

const SPAN_MS: Record<SpanChoice, number> = {
	hour: 60 * 60 * 1000,
	day: 24 * 60 * 60 * 1000,
	week: 7 * 24 * 60 * 60 * 1000
};

/** The most records the panel keeps while following. */
export const SHOWN_LIMIT = 2000;
const PAGE_LIMIT = 500;

export type Filters = { level: LevelChoice; source: SourceChoice; span: SpanChoice };

export type Cursor = { kind: 'none' } | { kind: 'older' | 'newer'; cursor: string };

export function logsUrl(machineId: string, filters: Filters, cursor: Cursor, now: number): string {
	const query = new URLSearchParams({
		level: filters.level,
		since: new Date(now - SPAN_MS[filters.span]).toISOString(),
		limit: String(PAGE_LIMIT)
	});
	if (filters.source !== 'all') query.set('source', filters.source);
	if (cursor.kind !== 'none') query.set('cursor', cursor.cursor);
	return `/api/diagnostics/machines/${machineId}/logs?${query.toString()}`;
}

export function recordKey(record: AgentLogRecordView): string {
	return `${record.instance}:${record.seq}`;
}

/** New records merged in, newest first by their own time, without repeats, at most SHOWN_LIMIT. */
export function mergeNewer(
	shown: readonly AgentLogRecordView[],
	arrived: readonly AgentLogRecordView[]
): AgentLogRecordView[] {
	const seen = new Set(shown.map(recordKey));
	const fresh = arrived.filter((record) => !seen.has(recordKey(record)));
	return [...fresh, ...shown].sort((a, b) => b.atIso.localeCompare(a.atIso)).slice(0, SHOWN_LIMIT);
}

/** What Copy shown and Download write: a heading, then one line per record, newest first. */
export function logText(
	machineName: string,
	records: readonly AgentLogRecordView[],
	now: number
): string {
	return [
		`BMuster agent log · ${machineName} · copied ${new Date(now).toISOString()} · ${records.length} records, newest first`,
		...records.map(agentRecordLine)
	].join('\n');
}

/** "42 min" or "1 h 5 min" left of a verbose window. */
export function remainingLabel(untilIso: string, now: number): string {
	const minutes = Math.max(0, Math.ceil((Date.parse(untilIso) - now) / 60_000));
	return minutes > 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
}
