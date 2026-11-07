import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Certificates the server made for local network mode (SPEC-INSTALL-OPTIONS
 * L4). The newest is the one served; older rows stay so a renewal is
 * traceable. The private key is encrypted with SECRETS_KEY.
 */
export const localCertificates = sqliteTable('local_certificates', {
	id: text().primaryKey(),
	certificatePem: text().notNull(),
	privateKeyEncrypted: text().notNull(),
	/** `sha256:<base64>` of the SubjectPublicKeyInfo, as agents pin it. */
	pin: text().notNull(),
	createdAt: integer({ mode: 'timestamp_ms' }).notNull()
});
