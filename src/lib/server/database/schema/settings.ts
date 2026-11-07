import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** A changed server setting. A setting with no row has its declared default. */
export const settings = sqliteTable('settings', {
	key: text().primaryKey(),
	/** JSON value, checked against the setting's declared type on read and write. */
	value: text().notNull(),
	updatedAt: integer({ mode: 'timestamp_ms' }).notNull(),
	updatedBy: text().notNull()
});
