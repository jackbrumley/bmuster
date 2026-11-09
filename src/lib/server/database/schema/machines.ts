import { index, integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { joinCodes } from './join-codes.ts';
import { users } from './users.ts';

/**
 * One enrolled machine. `removedAt` marks a machine that left this server (removed by an admin,
 * uninstalled, or moved); the row stays for the audit log. `movedAt` is also set when it left
 * by moving to another server (SPEC-AGENT-LOCAL).
 */
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
	lastUserSeenAt: integer({ mode: 'timestamp_ms' }),
	/** When the agent said it moved to another server (signed leave); null otherwise. */
	movedAt: integer({ mode: 'timestamp_ms' }),
	/**
	 * Which local page codes the agent takes, from its last check-in (SPEC-AGENT-LOCAL 7):
	 * `shared` (one code per machine, older agents) or `per-person` (each person's own code).
	 */
	localCodes: text({ enum: ['shared', 'per-person'] })
		.notNull()
		.default('shared'),
	/** The highest local page event sequence number taken; resent events at or below it are ignored. */
	localEventsSeq: integer().notNull().default(0),
	/**
	 * When its live socket last opened (SPEC-PRESENCE P1); null for an agent that has never held
	 * one, which keeps the check-in rule for its status.
	 */
	socketConnectedAt: integer({ mode: 'timestamp_ms' }),
	/**
	 * When its live socket closed, set once the grace period ran out and it went offline
	 * (SPEC-PRESENCE P2); null while it is online. A restart reads it to know who was offline.
	 */
	socketOfflineSince: integer({ mode: 'timestamp_ms' }),
	/**
	 * Until when the agent logs its own debug records (SPEC-AGENT-LOGS 1); null at the normal
	 * level. Sent to the agent again when it reconnects before then.
	 */
	verboseUntil: integer({ mode: 'timestamp_ms' })
});

/**
 * The agent's local page (SPEC-AGENT-LOCAL): its sign-in secret, sealed with SECRETS_KEY, so
 * the console can show admins the current code, and its certificate so people can check the
 * browser warning. One row per machine, replaced when the agent reports again.
 */
export const machineLocalPages = sqliteTable('machine_local_pages', {
	machineId: text()
		.primaryKey()
		.references(() => machines.id),
	/** The 20-byte TOTP secret (RFC 6238, SHA-1, 6 digits, 30 s), sealed. */
	totpSecretSealed: text().notNull(),
	/** SHA-256 of the page's certificate (DER), lower-case hex. */
	certificateSha256: text().notNull(),
	port: integer().notNull(),
	reportedAt: integer({ mode: 'timestamp_ms' }).notNull()
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
