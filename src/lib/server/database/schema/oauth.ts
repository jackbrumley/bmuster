import { blob, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { users } from './users.ts';

/**
 * AI assistants connected over MCP (SPEC-MCP 13.1). BMuster is its own OAuth authorisation
 * server for public clients only: no client secrets. Codes and tokens are opaque and kept only
 * as SHA-256.
 */

/**
 * A client: one that names itself with a Client ID Metadata Document (its `client_id` is the
 * HTTPS URL of the document, so its name is tied to that URL's host), or one registered through
 * Dynamic Client Registration (its name is its own claim: unverified).
 */
export const oauthClients = sqliteTable('oauth_clients', {
	id: text().primaryKey(),
	kind: text({ enum: ['metadata-document', 'registered'] }).notNull(),
	clientId: text().notNull().unique(),
	name: text().notNull(),
	/** The client's home page from its metadata; '' when it gave none. */
	clientUri: text().notNull(),
	/** Reserved for a logo fetched from the metadata document; not fetched yet. */
	logo: blob({ mode: 'buffer' }),
	/** JSON array of the redirect URIs it may use. */
	redirectUris: text().notNull(),
	/** JSON: the metadata as received, for the record. */
	metadata: text().notNull(),
	/** When a metadata document was last fetched; null for a registered client. */
	fetchedAt: integer({ mode: 'timestamp_ms' }),
	createdAt: integer({ mode: 'timestamp_ms' }).notNull()
});

/** One person's Allow for one client: what they see on the Account page and can disconnect. */
export const oauthGrants = sqliteTable(
	'oauth_grants',
	{
		id: text().primaryKey(),
		userId: text()
			.notNull()
			.references(() => users.id),
		oauthClientId: text()
			.notNull()
			.references(() => oauthClients.id),
		/** JSON array of the scopes allowed. */
		scopes: text().notNull(),
		createdAt: integer({ mode: 'timestamp_ms' }).notNull(),
		lastUsedAt: integer({ mode: 'timestamp_ms' }),
		lastIp: text(),
		lastUserAgent: text(),
		endedAt: integer({ mode: 'timestamp_ms' }),
		endedReason: text({
			enum: [
				'disconnected',
				'refresh-reuse',
				'code-reuse',
				'expired',
				'user-disabled',
				'not-in-group',
				'mcp-off',
				'kill-switch'
			]
		})
	},
	(table) => [index('oauth_grants_user').on(table.userId)]
);

/** An authorisation code: 60 seconds, single use, bound to its PKCE challenge and redirect. */
export const oauthCodes = sqliteTable('oauth_codes', {
	hash: text().primaryKey(),
	grantId: text()
		.notNull()
		.references(() => oauthGrants.id),
	codeChallenge: text().notNull(),
	redirectUri: text().notNull(),
	resource: text().notNull(),
	scopes: text().notNull(),
	expiresAt: integer({ mode: 'timestamp_ms' }).notNull(),
	usedAt: integer({ mode: 'timestamp_ms' })
});

/**
 * An access or refresh token. Refresh tokens rotate on every use within a family; a used one
 * presented again ends the whole grant. `expiresAt` is a refresh family's 30-day limit, and
 * `idleExpiresAt` its 7 days without use; access tokens have only `expiresAt`.
 */
export const oauthTokens = sqliteTable(
	'oauth_tokens',
	{
		hash: text().primaryKey(),
		grantId: text()
			.notNull()
			.references(() => oauthGrants.id),
		kind: text({ enum: ['access', 'refresh'] }).notNull(),
		familyId: text().notNull(),
		expiresAt: integer({ mode: 'timestamp_ms' }).notNull(),
		idleExpiresAt: integer({ mode: 'timestamp_ms' }),
		usedAt: integer({ mode: 'timestamp_ms' }),
		revokedAt: integer({ mode: 'timestamp_ms' })
	},
	(table) => [index('oauth_tokens_grant').on(table.grantId)]
);
