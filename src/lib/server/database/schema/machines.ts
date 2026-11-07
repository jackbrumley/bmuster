import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { joinCodes } from './join-codes.ts';
import { users } from './users.ts';

/** One enrolled machine. `removedAt` marks a removed machine; the row stays for the audit log. */
export const machines = sqliteTable('machines', {
	id: text().primaryKey(),
	name: text().notNull(),
	hostname: text().notNull(),
	osFamily: text({ enum: ['windows', 'linux', 'macos'] }).notNull(),
	target: text().notNull(),
	agentVersion: text().notNull(),
	/** Ed25519 public key, base64. */
	publicKey: text().notNull(),
	/** Highest signed-request timestamp accepted; a request must beat it (no replays). */
	lastRequestMs: integer().notNull(),
	checkInSeconds: integer().notNull(),
	enrolledAt: integer({ mode: 'timestamp_ms' }).notNull(),
	lastSeenAt: integer({ mode: 'timestamp_ms' }).notNull(),
	removedAt: integer({ mode: 'timestamp_ms' }),
	/** The join code the machine enrolled with; null for machines enrolled before it was kept. */
	joinCodeId: text().references(() => joinCodes.id),
	/** What the machine is for, in the admins' words (SPEC-MACHINE-DETAILS D2). Plain text. */
	description: text().notNull().default(''),
	/** The last person a check-in reported at the machine (D7); kept after they sign out. */
	lastUserName: text(),
	lastUserSeenAt: integer({ mode: 'timestamp_ms' })
});

/** Notes people keep on a machine (SPEC-MACHINE-DETAILS D3, D4). Deleted notes keep their row. */
export const machineNotes = sqliteTable(
	'machine_notes',
	{
		id: text().primaryKey(),
		machineId: text()
			.notNull()
			.references(() => machines.id),
		authorUserId: text()
			.notNull()
			.references(() => users.id),
		/** Plain text, line breaks kept. */
		body: text().notNull(),
		createdAt: integer({ mode: 'timestamp_ms' }).notNull(),
		editedAt: integer({ mode: 'timestamp_ms' }),
		deletedAt: integer({ mode: 'timestamp_ms' })
	},
	(table) => [index('machine_notes_machine').on(table.machineId, table.createdAt)]
);

/** The latest figures from a check-in. One row per machine. */
export const machineStatus = sqliteTable('machine_status', {
	machineId: text()
		.primaryKey()
		.references(() => machines.id),
	/** JSON: { kind: 'none' } | { kind: 'user', name } */
	signedInUser: text().notNull(),
	cpuPercent: real().notNull(),
	memoryUsedBytes: integer().notNull(),
	uptimeSeconds: integer().notNull(),
	updatedAt: integer({ mode: 'timestamp_ms' }).notNull()
});

/** The latest full inventory the agent sent, kept as JSON with its hash. */
export const machineInventory = sqliteTable('machine_inventory', {
	machineId: text()
		.primaryKey()
		.references(() => machines.id),
	hash: text().notNull(),
	data: text().notNull(),
	updatedAt: integer({ mode: 'timestamp_ms' }).notNull()
});
