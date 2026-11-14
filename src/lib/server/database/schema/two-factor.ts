import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { users } from './users.ts';

/**
 * A person's authenticator app (SPEC-TWO-FACTOR 5): one per person. The key is sealed with
 * SECRETS_KEY. `enabledAt` is null while set-up waits for the first code; two-factor is on
 * once it is set.
 */
export const totpAuthenticators = sqliteTable('totp_authenticators', {
	userId: text()
		.primaryKey()
		.references(() => users.id),
	secretSealed: text().notNull(),
	enabledAt: integer({ mode: 'timestamp_ms' }),
	/** The last 30-second step a code was accepted for, so no step is accepted twice. */
	lastUsedStep: integer(),
	createdAt: integer({ mode: 'timestamp_ms' }).notNull()
});

/** Single-use recovery codes: only the SHA-256 of each 80-bit code is kept. */
export const recoveryCodes = sqliteTable(
	'recovery_codes',
	{
		id: text().primaryKey(),
		userId: text()
			.notNull()
			.references(() => users.id),
		codeHash: text().notNull(),
		createdAt: integer({ mode: 'timestamp_ms' }).notNull(),
		usedAt: integer({ mode: 'timestamp_ms' })
	},
	(table) => [index('recovery_codes_user').on(table.userId, table.codeHash)]
);

/**
 * The half-signed-in state (SPEC-TWO-FACTOR 2.3): a right password with a second step to go.
 * Only the SHA-256 of the cookie's token is kept. It grants nothing but the step's own page.
 */
export const signInChallenges = sqliteTable('sign_in_challenges', {
	idHash: text().primaryKey(),
	userId: text()
		.notNull()
		.references(() => users.id),
	step: text({ enum: ['code', 'set-up'] }).notNull(),
	createdAt: integer({ mode: 'timestamp_ms' }).notNull(),
	expiresAt: integer({ mode: 'timestamp_ms' }).notNull(),
	ip: text().notNull(),
	userAgent: text().notNull()
});
