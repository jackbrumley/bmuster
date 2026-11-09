import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

const LOG_LEVELS = ['error', 'warn', 'info', 'debug', 'trace'] as const;

/**
 * Log records agents ship over their live socket (SPEC-AGENT-LOGS 2). The key is the agent
 * process (`instance`) and its sequence number, so a resent record is ignored. `machineId` comes
 * from the authenticated socket, never from the agent's message. No foreign key: a removed
 * machine keeps its records until they age out.
 */
export const agentLogRecords = sqliteTable(
	'agent_log_records',
	{
		machineId: text().notNull(),
		instance: text().notNull(),
		seq: integer().notNull(),
		at: integer({ mode: 'timestamp_ms' }).notNull(),
		level: text({ enum: LOG_LEVELS }).notNull(),
		/** `agent` (its own code), `helper` (a child's stderr) or `journal` (the fixed query). */
		source: text({ enum: ['agent', 'helper', 'journal'] }).notNull(),
		/** Module path, or the helper's name. */
		target: text().notNull(),
		text: text().notNull(),
		receivedAt: integer({ mode: 'timestamp_ms' }).notNull()
	},
	(table) => [
		primaryKey({ columns: [table.machineId, table.instance, table.seq] }),
		index('agent_log_records_machine_at').on(table.machineId, table.at)
	]
);

/** The server logger's own records at info and above (SPEC-AGENT-LOGS 2). */
export const serverLogRecords = sqliteTable(
	'server_log_records',
	{
		instance: text().notNull(),
		seq: integer().notNull(),
		at: integer({ mode: 'timestamp_ms' }).notNull(),
		level: text({ enum: LOG_LEVELS }).notNull(),
		/** What part of the server wrote it: sessions, relay, agents, updates, auth, … */
		area: text().notNull(),
		/** The machine the record is about, where known. */
		machineId: text(),
		text: text().notNull()
	},
	(table) => [
		primaryKey({ columns: [table.instance, table.seq] }),
		index('server_log_records_at').on(table.at)
	]
);
