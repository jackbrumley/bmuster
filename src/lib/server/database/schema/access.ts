import { index, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { machines } from './machines.ts';
import { users } from './users.ts';

/** A group of people (SPEC-ACCESS A1). */
export const userGroups = sqliteTable('user_groups', {
	id: text().primaryKey(),
	name: text().notNull().unique(),
	description: text().notNull().default(''),
	createdAt: integer({ mode: 'timestamp_ms' }).notNull()
});

export const userGroupMembers = sqliteTable(
	'user_group_members',
	{
		userGroupId: text()
			.notNull()
			.references(() => userGroups.id),
		userId: text()
			.notNull()
			.references(() => users.id)
	},
	(table) => [
		primaryKey({ columns: [table.userGroupId, table.userId] }),
		index('user_group_members_user').on(table.userId)
	]
);

/**
 * A group of machines (A2). `builtIn` is `all` for the one All machines group
 * (A3), which holds every machine without storing them; null otherwise. Unique,
 * so there can only ever be one.
 */
export const machineGroups = sqliteTable('machine_groups', {
	id: text().primaryKey(),
	name: text().notNull().unique(),
	description: text().notNull().default(''),
	builtIn: text({ enum: ['all'] }).unique(),
	createdAt: integer({ mode: 'timestamp_ms' }).notNull()
});

export const machineGroupMembers = sqliteTable(
	'machine_group_members',
	{
		machineGroupId: text()
			.notNull()
			.references(() => machineGroups.id),
		machineId: text()
			.notNull()
			.references(() => machines.id)
	},
	(table) => [
		primaryKey({ columns: [table.machineGroupId, table.machineId] }),
		index('machine_group_members_machine').on(table.machineId)
	]
);

/** One user group may do these things on one machine group (A4). */
export const accessRules = sqliteTable('access_rules', {
	id: text().primaryKey(),
	userGroupId: text()
		.notNull()
		.references(() => userGroups.id),
	machineGroupId: text()
		.notNull()
		.references(() => machineGroups.id),
	/** JSON array of permissions, always complete (every one includes `view`). */
	permissions: text().notNull(),
	consent: text({ enum: ['unattended', 'ask'] }).notNull(),
	createdAt: integer({ mode: 'timestamp_ms' }).notNull(),
	createdBy: text().references(() => users.id)
});
