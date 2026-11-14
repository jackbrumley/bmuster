import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { machines } from './machines.ts';
import { oauthGrants } from './oauth.ts';
import { users } from './users.ts';

/**
 * One command run on many machines (SPEC-COMMANDS 4). A run an AI assistant asked for
 * (SPEC-MCP 13.2) starts as `pending-approval` and runs only after a person approves it;
 * `startedBy` is the person the assistant acts as, `decidedBy` the person who approved or denied.
 */
export const commandRuns = sqliteTable(
	'command_runs',
	{
		id: text().primaryKey(),
		startedBy: text()
			.notNull()
			.references(() => users.id),
		startedAt: integer({ mode: 'timestamp_ms' }).notNull(),
		endedAt: integer({ mode: 'timestamp_ms' }),
		status: text({
			enum: ['pending-approval', 'running', 'finished', 'cancelled', 'denied', 'expired']
		}).notNull(),
		timeoutMs: integer().notNull(),
		/** The run this one ran again on failed and offline machines (C18). */
		rerunOf: text(),
		/** Who asked for it: a person on the Commands tab, or an AI assistant (SPEC-MCP M17). */
		requester: text({ enum: ['person', 'assistant'] })
			.notNull()
			.default('person'),
		/** The assistant's connection, for an assistant's run. */
		oauthGrantId: text().references(() => oauthGrants.id),
		/** The assistant's reason, shown on the approval card. */
		reason: text(),
		/** A pending run can no longer be approved after this (M21). */
		expiresAt: integer({ mode: 'timestamp_ms' }),
		/** Who approved or denied it, and when (M19, M20). */
		decidedBy: text().references(() => users.id),
		decidedAt: integer({ mode: 'timestamp_ms' }),
		/** The approver's note to the assistant when denied. */
		denyNote: text(),
		/** The assistant's time limit when the approver changed it. */
		requestedTimeoutMs: integer()
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
		/** What runs: the approver's edit, when they edited it. */
		command: text().notNull(),
		/** The assistant's command, when the approver edited it (SPEC-MCP M20). */
		requestedCommand: text()
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
