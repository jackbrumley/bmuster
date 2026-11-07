import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** An OpenID Connect provider people can sign in with. The client secret is sealed with SECRETS_KEY. */
export const identityProviders = sqliteTable('identity_providers', {
	id: text().primaryKey(),
	name: text().notNull(),
	kind: text({ enum: ['microsoft-entra', 'authentik', 'generic-oidc'] }).notNull(),
	issuer: text().notNull(),
	clientId: text().notNull(),
	clientSecretSealed: text().notNull(),
	/** JSON array of scopes, e.g. ["openid","email","profile"]. */
	scopes: text().notNull(),
	newPeople: text({ enum: ['invited', 'auto-create'] }).notNull(),
	enabled: integer({ mode: 'boolean' }).notNull(),
	createdAt: integer({ mode: 'timestamp_ms' }).notNull()
});
