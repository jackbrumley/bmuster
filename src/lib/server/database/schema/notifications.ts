import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { users } from './users.ts';

/**
 * Who hears about which event (SPEC-EMAIL E6). A rule names one event kind,
 * a scope (any machine, a machine group or one machine) and its recipients
 * (a user group or a list of addresses). Nothing is on by default.
 */
export const notificationRules = sqliteTable('notification_rules', {
	id: text().primaryKey(),
	eventKind: text().notNull(),
	scopeKind: text({ enum: ['any-machine', 'machine-group', 'machine'] }).notNull(),
	/** The machine group or machine id; null for any machine. */
	scopeId: text(),
	recipientsKind: text({ enum: ['user-group', 'addresses'] }).notNull(),
	/** The user group id; null when the rule lists addresses. */
	userGroupId: text(),
	/** JSON array of lower-case addresses; empty when the rule names a user group. */
	addresses: text().notNull(),
	enabled: integer({ mode: 'boolean' }).notNull(),
	createdBy: text()
		.notNull()
		.references(() => users.id),
	createdAt: integer({ mode: 'timestamp_ms' }).notNull()
});

/**
 * Events waiting to be matched against the rules (an outbox). The code where
 * something happens writes one in its own transaction, so no event is lost;
 * the email worker turns it into emails and deletes it.
 */
export const notificationEvents = sqliteTable('notification_events', {
	id: text().primaryKey(),
	kind: text().notNull(),
	/** The machine the event is about. */
	machineId: text().notNull(),
	/** JSON object of strings: what the email says about the event. */
	detail: text().notNull(),
	at: integer({ mode: 'timestamp_ms' }).notNull()
});
