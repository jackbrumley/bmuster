import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** A code a machine uses to join. Only its SHA-256 hash is kept. */
export const joinCodes = sqliteTable('join_codes', {
	id: text().primaryKey(),
	codeHash: text().notNull().unique(),
	/** JSON array of machine group ids the machine joins. */
	machineGroupIds: text().notNull(),
	maxUses: integer().notNull(),
	uses: integer().notNull(),
	createdAt: integer({ mode: 'timestamp_ms' }).notNull(),
	expiresAt: integer({ mode: 'timestamp_ms' }).notNull()
});
