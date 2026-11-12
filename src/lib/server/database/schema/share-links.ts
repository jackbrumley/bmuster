import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { machines } from './machines.ts';
import { users } from './users.ts';

/**
 * Share links (SPEC-SHARE-LINKS): someone without an account may reach one
 * machine for a limited time. Only the SHA-256 of the token is kept; the
 * token itself is shown once, to its creator.
 */
export const shareLinks = sqliteTable(
	'share_links',
	{
		id: text().primaryKey(),
		machineId: text()
			.notNull()
			.references(() => machines.id),
		/** Lower-case hex SHA-256 of the token text. */
		tokenHash: text().notNull().unique(),
		/** Who it is for, as the creator wrote it ("Dave, Acme Printers"). */
		recipient: text().notNull(),
		/** JSON list of `desktop-view`, `desktop-control`, `files`. */
		permissions: text().notNull(),
		createdBy: text()
			.notNull()
			.references(() => users.id),
		createdAt: integer({ mode: 'timestamp_ms' }).notNull(),
		expiresAt: integer({ mode: 'timestamp_ms' }).notNull(),
		/** Null while the link is active. */
		endedAt: integer({ mode: 'timestamp_ms' }),
		/** Who pressed End now; null when it expired or ended by itself (its creator lost access). */
		endedBy: text().references(() => users.id),
		/**
		 * The last guest session through the link (SPEC-SHARE-LINKS D17): the name and company the
		 * guest typed (self-declared; company '' when not given) and their address. All null until
		 * the first session.
		 */
		lastGuestName: text(),
		lastGuestCompany: text(),
		lastGuestAddress: text(),
		lastUsedAt: integer({ mode: 'timestamp_ms' })
	},
	(table) => [index('share_links_machine').on(table.machineId, table.endedAt)]
);

/** Wrong or ended share-link tokens and bad guest cookies, per address, for the rate limit. */
export const shareLinkFailures = sqliteTable(
	'share_link_failures',
	{
		id: text().primaryKey(),
		address: text().notNull(),
		failedAt: integer({ mode: 'timestamp_ms' }).notNull()
	},
	(table) => [
		index('share_link_failures_address').on(table.address, table.failedAt),
		index('share_link_failures_failed_at').on(table.failedAt)
	]
);
