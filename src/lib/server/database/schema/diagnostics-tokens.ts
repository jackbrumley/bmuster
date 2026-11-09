import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { users } from './users.ts';

/**
 * Read-only diagnostics tokens (SPEC-AGENT-LOGS 4). Only the SHA-256 of the token is kept. A token
 * works while it has not expired or been revoked and its admin is still an enabled admin.
 */
export const diagnosticsTokens = sqliteTable(
	'diagnostics_tokens',
	{
		id: text().primaryKey(),
		name: text().notNull(),
		/** Lower-case hex SHA-256 of the whole token text. */
		tokenHash: text().notNull().unique(),
		userId: text()
			.notNull()
			.references(() => users.id),
		createdAt: integer({ mode: 'timestamp_ms' }).notNull(),
		expiresAt: integer({ mode: 'timestamp_ms' }).notNull(),
		revokedAt: integer({ mode: 'timestamp_ms' }),
		lastUsedAt: integer({ mode: 'timestamp_ms' }),
		/** Use is audited at most once an hour per token. */
		lastAuditedAt: integer({ mode: 'timestamp_ms' })
	},
	(table) => [index('diagnostics_tokens_user').on(table.userId)]
);
