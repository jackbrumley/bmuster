import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { machines } from './machines.ts';

/**
 * The staged roll-out of one agent version (SPEC-AGENT-UPDATES): the Early updates group, then
 * 10% of the rest, then everyone, an hour apart. A failed update pauses it (`pausedBy` null:
 * the server did); an admin can pause and resume it. Resuming restarts the stage's hour.
 */
export const agentRollouts = sqliteTable('agent_rollouts', {
	version: text().primaryKey(),
	startedAt: integer({ mode: 'timestamp_ms' }).notNull(),
	stage: text({ enum: ['early', 'tenth', 'all'] }).notNull(),
	stageStartedAt: integer({ mode: 'timestamp_ms' }).notNull(),
	pausedAt: integer({ mode: 'timestamp_ms' }),
	pausedReason: text(),
	pausedBy: text()
});

/**
 * One machine's agent updates. `launcher` is what its last check-in said: false for agents
 * started without the launcher (installed before it existed), which cannot update themselves.
 * `requested*` is an admin's Update now; `offered*` the last offer sent; `lastEvent*` the last
 * update, rollback or refusal the agent reported (`lastEventAt` is the agent's own time, so a
 * report is recorded once).
 */
export const machineUpdates = sqliteTable('machine_updates', {
	machineId: text()
		.primaryKey()
		.references(() => machines.id),
	launcher: integer({ mode: 'boolean' }).notNull(),
	pinnedAt: integer({ mode: 'timestamp_ms' }),
	pinnedBy: text(),
	requestedVersion: text(),
	requestedAt: integer({ mode: 'timestamp_ms' }),
	offeredVersion: text(),
	offeredAt: integer({ mode: 'timestamp_ms' }),
	lastEventKind: text({ enum: ['none', 'updated', 'rolled-back', 'refused'] })
		.notNull()
		.default('none'),
	lastEventVersion: text().notNull().default(''),
	lastEventReason: text().notNull().default(''),
	lastEventAt: integer({ mode: 'timestamp_ms' })
});
