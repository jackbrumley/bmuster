import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { machines } from './machines.ts';
import { users } from './users.ts';

/** One command run on many machines (SPEC-COMMANDS 4). */
export const commandRuns = sqliteTable(
	'command_runs',
	{
		id: text().primaryKey(),
		startedBy: text()
			.notNull()
			.references(() => users.id),
		startedAt: integer({ mode: 'timestamp_ms' }).notNull(),
		endedAt: integer({ mode: 'timestamp_ms' }),
		status: text({ enum: ['running', 'finished', 'cancelled'] }).notNull(),
		timeoutMs: integer().notNull(),
		/** The run this one ran again on failed and offline machines (C18). */
		rerunOf: text()
	},
	(table) => [index('command_runs_started').on(table.startedAt)]
);

/** The command for one system in a run: one row per system (C6). */
export const commandRunScripts = sqliteTable(
	'command_run_scripts',
	{
		runId: text()
			.notNull()
			.references(() => commandRuns.id),
		osFamily: text({ enum: ['windows', 'linux'] }).notNull(),
		shell: text({ enum: ['powershell', 'cmd', 'sh', 'bash'] }).notNull(),
		command: text().notNull()
	},
	(table) => [primaryKey({ columns: [table.runId, table.osFamily] })]
);

/**
 * One machine in a run and how it went (C16). Output is capped at 1 MB per stream and set to
 * null 30 days after the run; the row, exit code, size and hash stay.
 */
export const commandRunMachines = sqliteTable(
	'command_run_machines',
	{
		runId: text()
			.notNull()
			.references(() => commandRuns.id),
		machineId: text()
			.notNull()
			.references(() => machines.id),
		/** Its place in the run: machines start in this order (C14). */
		position: integer().notNull(),
		status: text({
			enum: [
				'waiting',
				'running',
				'succeeded',
				'failed',
				'timed-out',
				'offline',
				'skipped',
				'lost',
				'cancelled'
			]
		}).notNull(),
		/** Why it was skipped, lost or could not run. */
		skipReason: text(),
		/** The agent's session for this machine, which joins the row to its timeline. */
		sessionId: text(),
		exitCode: integer(),
		startedAt: integer({ mode: 'timestamp_ms' }),
		endedAt: integer({ mode: 'timestamp_ms' }),
		durationMs: integer(),
		stdout: text(),
		stderr: text(),
		stdoutTruncated: integer({ mode: 'boolean' }).notNull().default(false),
		stderrTruncated: integer({ mode: 'boolean' }).notNull().default(false),
		/** Bytes kept, both streams, and the SHA-256 of stdout then stderr (for the audit). */
		outputBytes: integer(),
		outputSha256: text(),
		/** When stdout and stderr were deleted (30 days on). */
		outputDeletedAt: integer({ mode: 'timestamp_ms' })
	},
	(table) => [
		primaryKey({ columns: [table.runId, table.machineId] }),
		index('command_run_machines_ended').on(table.endedAt)
	]
);
