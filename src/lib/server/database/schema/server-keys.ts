import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/** The server's own Ed25519 key pair; the private key is encrypted with SECRETS_KEY. */
export const serverKeys = sqliteTable('server_keys', {
	id: text().primaryKey(),
	publicKey: text().notNull(),
	privateKeyEncrypted: text().notNull(),
	createdAt: integer({ mode: 'timestamp_ms' }).notNull()
});
