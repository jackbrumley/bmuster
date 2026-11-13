import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { users } from './users.ts';

/** A signed-in browser. Only the SHA-256 of the cookie's random id is kept. */
export const consoleSessions = sqliteTable('console_sessions', {
	idHash: text().primaryKey(),
	userId: text()
		.notNull()
		.references(() => users.id),
	createdAt: integer({ mode: 'timestamp_ms' }).notNull(),
	lastSeenAt: integer({ mode: 'timestamp_ms' }).notNull(),
	expiresAt: integer({ mode: 'timestamp_ms' }).notNull(),
	userAgent: text().notNull(),
	ip: text().notNull(),
	/**
	 * The last time the person typed their password again in this session (SPEC-COMMANDS C10).
	 * Null until they do: the sign-in itself (`createdAt`) is the first check.
	 */
	reconfirmedAt: integer({ mode: 'timestamp_ms' })
});

/** Failed password sign-ins, for the per-email and per-address pauses. Old rows are pruned. */
export const signInFailures = sqliteTable(
	'sign_in_failures',
	{
		id: text().primaryKey(),
		email: text().notNull(),
		address: text().notNull(),
		failedAt: integer({ mode: 'timestamp_ms' }).notNull()
	},
	(table) => [
		index('sign_in_failures_email').on(table.email, table.failedAt),
		index('sign_in_failures_address').on(table.address, table.failedAt)
	]
);
