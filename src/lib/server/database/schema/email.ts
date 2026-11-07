import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * The email queue and its record (SPEC-EMAIL E3, E8). A message waits here
 * until it is sent or given up. A body that holds a link which sets a
 * password is sealed with SECRETS_KEY while it waits; every body is wiped
 * once the message is done, so the record keeps only recipient, subject,
 * times and result.
 */
export const emailMessages = sqliteTable(
	'email_messages',
	{
		id: text().primaryKey(),
		kind: text({
			enum: ['test', 'password-reset', 'invitation', 'provider-sign-in', 'notification']
		}).notNull(),
		toAddress: text().notNull(),
		subject: text().notNull(),
		/**
		 * JSON: `{ text, html }`, or `{ sealed }` holding them sealed. Null once
		 * the message is sent or given up.
		 */
		body: text(),
		status: text({ enum: ['queued', 'sent', 'failed'] }).notNull(),
		attempts: integer().notNull(),
		nextAttemptAt: integer({ mode: 'timestamp_ms' }).notNull(),
		/** The last error, word for word, while retrying or after giving up. */
		lastError: text(),
		/** What the SMTP server answered when it took the message. */
		reply: text(),
		createdAt: integer({ mode: 'timestamp_ms' }).notNull(),
		finishedAt: integer({ mode: 'timestamp_ms' })
	},
	(table) => [
		index('email_messages_due').on(table.status, table.nextAttemptAt),
		index('email_messages_created').on(table.createdAt)
	]
);
