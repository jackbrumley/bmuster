import { integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';
import { identityProviders } from './identity-providers.ts';

/** Someone who can sign in to the console. `email` is stored in lower case. */
export const users = sqliteTable('users', {
	id: text().primaryKey(),
	name: text().notNull(),
	email: text().notNull().unique(),
	role: text({ enum: ['admin', 'member'] }).notNull(),
	/** Argon2id hash; null for someone who signs in only through a provider. */
	passwordHash: text(),
	disabledAt: integer({ mode: 'timestamp_ms' }),
	createdAt: integer({ mode: 'timestamp_ms' }).notNull(),
	lastSignInAt: integer({ mode: 'timestamp_ms' })
});

/** A provider account linked to a user, by the provider's stable subject (never the email). */
export const userIdentities = sqliteTable(
	'user_identities',
	{
		id: text().primaryKey(),
		userId: text()
			.notNull()
			.references(() => users.id),
		providerId: text()
			.notNull()
			.references(() => identityProviders.id, { onDelete: 'cascade' }),
		subject: text().notNull()
	},
	(table) => [unique().on(table.providerId, table.subject)]
);
