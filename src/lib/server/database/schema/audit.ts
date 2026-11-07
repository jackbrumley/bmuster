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
		/**
		 * The machine the entry is about, if any: members see only entries about
		 * machines they can see (SPEC-ACCESS A6). Null for older entries.
		 */
		machineId: text(),
		/** JSON object of strings. */
		detail: text().notNull()
	},
	(table) => [
		index('audit_entries_at').on(table.at),
		index('audit_entries_machine').on(table.machineId, table.at)
	]
);
