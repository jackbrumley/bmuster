import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** One line of the audit log. `actorUserId` is null for the system or an unknown person. */
export const auditEntries = sqliteTable(
	'audit_entries',
	{
		id: text().primaryKey(),
		at: integer({ mode: 'timestamp_ms' }).notNull(),
		actorUserId: text(),
		kind: text().notNull(),
		/** What the entry is about, e.g. an email address or a provider name. */
		target: text().notNull(),
		/** JSON object of strings. */
		detail: text().notNull()
	},
	(table) => [index('audit_entries_at').on(table.at)]
);
