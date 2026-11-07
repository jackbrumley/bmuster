import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { users } from './users.ts';

/**
 * Single-use links that let someone set a password (SPEC-EMAIL E4, E5): a
 * password reset (30 minutes) or an invitation (7 days). Only the SHA-256 of
 * the link's random token is kept.
 */
export const passwordLinks = sqliteTable(
	'password_links',
	{
		tokenHash: text().primaryKey(),
		userId: text()
			.notNull()
			.references(() => users.id),
		purpose: text({ enum: ['reset', 'invitation'] }).notNull(),
		createdAt: integer({ mode: 'timestamp_ms' }).notNull(),
		expiresAt: integer({ mode: 'timestamp_ms' }).notNull(),
		usedAt: integer({ mode: 'timestamp_ms' })
	},
	(table) => [index('password_links_user').on(table.userId, table.purpose)]
);
