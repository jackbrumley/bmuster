import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { joinCodes } from './join-codes.ts';
import { users } from './users.ts';

/**
 * A phone support code (SPEC-JOIN): six digits a caller types on /join,
 * standing for one single-use join code.
 */
export const supportCodes = sqliteTable(
	'support_codes',
	{
		id: text().primaryKey(),
		/** HMAC-SHA-256 of the digits keyed with SECRETS_KEY: a million codes are too few for a plain hash. */
		codeHash: text().notNull(),
		joinCodeId: text()
			.notNull()
			.references(() => joinCodes.id),
		/** The join code, sealed with SECRETS_KEY, so /join can show it; null once cancelled. */
		joinCodeSealed: text(),
		createdBy: text()
			.notNull()
			.references(() => users.id),
		createdAt: integer({ mode: 'timestamp_ms' }).notNull(),
		expiresAt: integer({ mode: 'timestamp_ms' }).notNull(),
		cancelledAt: integer({ mode: 'timestamp_ms' }),
		/** The first time the code was typed on /join. */
		enteredAt: integer({ mode: 'timestamp_ms' })
	},
	(table) => [index('support_codes_code_hash').on(table.codeHash, table.createdAt)]
);

/** Wrong support codes typed on /join, for the guessing limits (SPEC-JOIN 5). Old rows are pruned. */
export const supportCodeFailures = sqliteTable(
	'support_code_failures',
	{
		id: text().primaryKey(),
		address: text().notNull(),
		failedAt: integer({ mode: 'timestamp_ms' }).notNull()
	},
	(table) => [
		index('support_code_failures_address').on(table.address, table.failedAt),
		index('support_code_failures_failed_at').on(table.failedAt)
	]
);
