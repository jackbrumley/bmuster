import { and, asc, eq } from 'drizzle-orm';
import {
	permissionLabel,
	type AccessRuleView,
	type Consent,
	type Permission
} from '#lib/domain/access/access.ts';
import { storedPermissionsSchema } from '#lib/schemas/access/access.ts';
import { accessRules, machineGroups, userGroups } from '../../database/schema.ts';
import type { AppDatabase, Queryable } from '../../database/connection.ts';
import { recordAudit } from '../audit/audit.ts';
import { getSetting } from '../settings/settings.ts';

/**
 * Access rules (SPEC-ACCESS A4, A8, A9): one user group may do these things
 * on one machine group. The permission set is always complete (the request
 * schema refuses one that is not). One rule per pair of groups, so a pair's
 * permissions are edited in one place. Every change is audited.
 */
export type RuleInput = {
	userGroupId: string;
	machineGroupId: string;
	permissions: Permission[];
	consent: Consent;
};

export type RuleChange =
	{ kind: 'done'; id: string } | { kind: 'refused'; status: 404 | 409; message: string };

type RuleRow = typeof accessRules.$inferSelect;

const NO_RULE: RuleChange = {
	kind: 'refused',
	status: 404,
	message: 'No access rule with this id.'
};

function permissionsOf(row: RuleRow): Permission[] {
	return storedPermissionsSchema.parse(JSON.parse(row.permissions));
}

export function listAccessRules(database: Queryable): AccessRuleView[] {
	return database
		.select()
		.from(accessRules)
		.orderBy(asc(accessRules.createdAt))
		.all()
		.map((row) => ({
			id: row.id,
			userGroupId: row.userGroupId,
			machineGroupId: row.machineGroupId,
			permissions: permissionsOf(row),
			consent: row.consent,
			createdIso: row.createdAt.toISOString()
		}));
}

/** What the New rule form starts with: just See inventory, and the server's default consent. */
export function newRuleDefaults(database: Queryable): {
	permissions: Permission[];
	consent: Consent;
} {
	return { permissions: ['view'], consent: getSetting(database, 'defaultConsent') };
}

/** "IT → Office", or undefined when either group is missing. */
function describePair(
	database: Queryable,
	userGroupId: string,
	machineGroupId: string
): string | undefined {
	const people = database
		.select({ name: userGroups.name })
		.from(userGroups)
		.where(eq(userGroups.id, userGroupId))
		.get();
	const machines = database
		.select({ name: machineGroups.name })
		.from(machineGroups)
		.where(eq(machineGroups.id, machineGroupId))
		.get();
	return people === undefined || machines === undefined
		? undefined
		: `${people.name} → ${machines.name}`;
}

function permissionsText(permissions: readonly Permission[]): string {
	return permissions.map(permissionLabel).join(', ');
}

/** True when another rule already joins the same two groups. */
function samePair(database: Queryable, input: RuleInput, exceptId: string | null): boolean {
	return database
		.select({ id: accessRules.id })
		.from(accessRules)
		.where(
			and(
				eq(accessRules.userGroupId, input.userGroupId),
				eq(accessRules.machineGroupId, input.machineGroupId)
			)
		)
		.all()
		.some((row) => row.id !== exceptId);
}

function checkPair(
	database: Queryable,
	input: RuleInput,
	exceptId: string | null
): RuleChange | string {
	const description = describePair(database, input.userGroupId, input.machineGroupId);
	if (description === undefined) {
		return { kind: 'refused', status: 404, message: 'One of the groups no longer exists.' };
	}
	if (samePair(database, input, exceptId)) {
		return {
			kind: 'refused',
			status: 409,
			message: `There is already a rule for ${description}. Change that one instead.`
		};
	}
	return description;
}

export function createRule(
	database: AppDatabase,
	actorUserId: string,
	input: RuleInput,
	now: number
): RuleChange {
	return database.transaction((tx) => {
		const checked = checkPair(tx, input, null);
		if (typeof checked !== 'string') {
			return checked;
		}
		const id = crypto.randomUUID();
		tx.insert(accessRules)
			.values({
				id,
				userGroupId: input.userGroupId,
				machineGroupId: input.machineGroupId,
				permissions: JSON.stringify(input.permissions),
				consent: input.consent,
				createdAt: new Date(now),
				createdBy: actorUserId
			})
			.run();
		recordAudit(
			tx,
			{
				actor: { kind: 'user', userId: actorUserId },
				kind: 'access-rule-added',
				target: checked,
				machineId: null,
				detail: { permissions: permissionsText(input.permissions), consent: input.consent }
			},
			now
		);
		return { kind: 'done', id };
	});
}

/** Changes a rule's groups, permissions or consent. Saving unchanged values records nothing. */
export function updateRule(
	database: AppDatabase,
	actorUserId: string,
	id: string,
	input: RuleInput,
	now: number
): RuleChange {
	return database.transaction((tx) => {
		const row = tx.select().from(accessRules).where(eq(accessRules.id, id)).get();
		if (row === undefined) {
			return NO_RULE;
		}
		const checked = checkPair(tx, input, id);
		if (typeof checked !== 'string') {
			return checked;
		}
		const before = describePair(tx, row.userGroupId, row.machineGroupId) ?? '(missing)';
		const detail: Record<string, string> = {};
		if (before !== checked) {
			detail['groups'] = `${before} → ${checked}`;
		}
		const beforePermissions = permissionsText(permissionsOf(row));
		const afterPermissions = permissionsText(input.permissions);
		if (beforePermissions !== afterPermissions) {
			detail['permissions'] = `${beforePermissions} → ${afterPermissions}`;
		}
		if (row.consent !== input.consent) {
			detail['consent'] = `${row.consent} → ${input.consent}`;
		}
		if (Object.keys(detail).length === 0) {
			return { kind: 'done', id };
		}
		tx.update(accessRules)
			.set({
				userGroupId: input.userGroupId,
				machineGroupId: input.machineGroupId,
				permissions: JSON.stringify(input.permissions),
				consent: input.consent
			})
			.where(eq(accessRules.id, id))
			.run();
		recordAudit(
			tx,
			{
				actor: { kind: 'user', userId: actorUserId },
				kind: 'access-rule-changed',
				target: checked,
				machineId: null,
				detail
			},
			now
		);
		return { kind: 'done', id };
	});
}

function deleteOne(
	tx: Queryable,
	row: RuleRow,
	actorUserId: string,
	reason: string,
	now: number
): string {
	const description = describePair(tx, row.userGroupId, row.machineGroupId) ?? '(missing)';
	tx.delete(accessRules).where(eq(accessRules.id, row.id)).run();
	recordAudit(
		tx,
		{
			actor: { kind: 'user', userId: actorUserId },
			kind: 'access-rule-deleted',
			target: description,
			machineId: null,
			detail: { permissions: permissionsText(permissionsOf(row)), reason }
		},
		now
	);
	return description;
}

export function deleteRule(
	database: AppDatabase,
	actorUserId: string,
	id: string,
	now: number
): RuleChange {
	return database.transaction((tx) => {
		const row = tx.select().from(accessRules).where(eq(accessRules.id, id)).get();
		if (row === undefined) {
			return NO_RULE;
		}
		deleteOne(tx, row, actorUserId, 'deleted', now);
		return { kind: 'done', id };
	});
}

/**
 * Deletes every rule that uses a group, as part of deleting the group (A8).
 * Call inside the group's transaction. Returns each rule's "IT → Office".
 */
export function deleteRulesOfGroup(
	tx: Queryable,
	kind: 'user' | 'machine',
	groupId: string,
	actorUserId: string,
	now: number
): string[] {
	const column = kind === 'user' ? accessRules.userGroupId : accessRules.machineGroupId;
	return tx
		.select()
		.from(accessRules)
		.where(eq(column, groupId))
		.all()
		.map((row) => deleteOne(tx, row, actorUserId, 'its group was deleted', now));
}
