import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** One enrolled machine. Inventory columns arrive with the check-in spec. */
export const machines = sqliteTable('machines', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	hostname: text('hostname').notNull(),
	osFamily: text('os_family', { enum: ['windows', 'linux', 'macos'] }).notNull(),
	publicKey: text('public_key').notNull(),
	enrolledAt: integer('enrolled_at', { mode: 'timestamp_ms' }).notNull(),
	lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }).notNull()
});
