import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { users } from './users.ts';

/** A code a machine uses to join. Only its SHA-256 hash is kept. */
export const joinCodes = sqliteTable('join_codes', {
	id: text().primaryKey(),
	codeHash: text().notNull().unique(),
	/** JSON array of machine group ids the machine joins. */
	machineGroupIds: text().notNull(),
	maxUses: integer().notNull(),
	uses: integer().notNull(),
	/** Who made the code; null for codes made before sign-in existed. */
	createdBy: text().references(() => users.id),
	createdAt: integer({ mode: 'timestamp_ms' }).notNull(),
	expiresAt: integer({ mode: 'timestamp_ms' }).notNull(),
	/**
	 * A reinstall code (SPEC-MACHINE-DETAILS D9): enrolling with it takes over
	 * this machine's row instead of making a new one. Null for plain codes. No
	 * foreign key: machines already references join_codes, and machine rows
	 * are never deleted.
	 */
	reinstallMachineId: text()
});
