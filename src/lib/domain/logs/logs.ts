/** Agent and server log records as the console and diagnostics readers see them (SPEC-AGENT-LOGS). */

export const LOG_LEVELS = ['error', 'warn', 'info', 'debug', 'trace'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const LOG_SOURCES = ['agent', 'helper', 'journal'] as const;
export type LogSource = (typeof LOG_SOURCES)[number];

/** At most this many records in one `log-batch`; the agent sends 500 at most. */
export const MAX_BATCH_RECORDS = 500;
/** A record's text is at most 4 KiB, cut with a marker by the agent. */
export const MAX_RECORD_TEXT = 4096;
export const MAX_RECORD_TARGET = 256;
/** At most this many records a minute from one machine. */
export const RECORDS_PER_MINUTE = 3000;
/** The longest verbose window. */
export const MAX_VERBOSE_MS = 4 * 60 * 60 * 1000;
/** The Verbose button's window. */
export const VERBOSE_FOR_MS = 60 * 60 * 1000;
/** The most records one read returns. */
export const MAX_READ_LIMIT = 2000;

export type AgentLogRecordView = {
	instance: string;
	seq: number;
	atIso: string;
	level: LogLevel;
	source: LogSource;
	target: string;
	text: string;
};

export type ServerLogRecordView = {
	instance: string;
	seq: number;
	atIso: string;
	level: LogLevel;
	area: string;
	machineId: string | null;
	text: string;
};

/** Which end of the window a read starts from (SPEC-AGENT-LOGS AL17). */
export const LOG_ORDERS = ['newest', 'oldest'] as const;
export type LogOrder = (typeof LOG_ORDERS)[number];

type LogContinuation = { kind: 'none' } | { kind: 'cursor'; cursor: string };

/**
 * A page of records. Read newest first (the default), `older` continues back in time; read oldest
 * first (`order=oldest`, from `since` forward), `later` continues forward. The other of the two is
 * always `none`. `newer` follows records that arrive after this read (the Live toggle), including
 * late ones from an agent's backlog.
 */
export type LogPage<R> = {
	records: R[];
	older: LogContinuation;
	later: LogContinuation;
	newer: string;
};

/** "error" and "warn" include everything more serious; "info" leaves out debug and trace. */
export function levelsAtOrAbove(level: LogLevel): LogLevel[] {
	return LOG_LEVELS.slice(0, LOG_LEVELS.indexOf(level) + 1);
}

/** One record as a plain text line, for Copy and Download. */
export function agentRecordLine(record: AgentLogRecordView): string {
	return `${record.atIso} ${record.level.toUpperCase().padEnd(5)} [${record.source}:${record.target}] ${record.text}`;
}

export function serverRecordLine(record: ServerLogRecordView): string {
	return `${record.atIso} ${record.level.toUpperCase().padEnd(5)} [${record.area}${record.machineId === null ? '' : ` ${record.machineId}`}] ${record.text}`;
}
