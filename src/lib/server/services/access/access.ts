import { eq, inArray } from 'drizzle-orm';
import {
	PERMISSIONS,
	type Consent,
	type Grant,
	type Permission
} from '#lib/domain/access/access.ts';
import type { ConsoleUser } from '#lib/domain/users/user.ts';
import { storedPermissionsSchema } from '#lib/schemas/access/access.ts';
import {
	accessRules,
	machineGroupMembers,
	machineGroups,
	userGroupMembers
} from '../../database/schema.ts';
import type { Queryable } from '../../database/connection.ts';
import { activeMachineNames, isActiveMachine } from '../machines/machine-views.ts';

/**
 * The one answer to "what may this person do on this machine" (SPEC-ACCESS
 * A5, AGENTS.md §11). Admins have every permission on every machine and
 * connect unattended. A member has the union of every rule whose user group
 * they are in and whose machine group holds the machine; a permission is
 * unattended when any rule giving it says so. Removed machines give nothing.
 */

type MemberRule = {
	machineGroupId: string;
	allMachines: boolean;
	permissions: Permission[];
	consent: Consent;
};

const EVERYTHING: Grant[] = PERMISSIONS.map((permission) => ({
	permission,
	consent: 'unattended'
}));

/** Every rule that applies to this member, through any of their user groups. */
function rulesFor(database: Queryable, userId: string): MemberRule[] {
	return database
		.select({
			machineGroupId: accessRules.machineGroupId,
			builtIn: machineGroups.builtIn,
			permissions: accessRules.permissions,
			consent: accessRules.consent
		})
		.from(accessRules)
		.innerJoin(userGroupMembers, eq(userGroupMembers.userGroupId, accessRules.userGroupId))
		.innerJoin(machineGroups, eq(machineGroups.id, accessRules.machineGroupId))
		.where(eq(userGroupMembers.userId, userId))
		.all()
		.map((row) => ({
			machineGroupId: row.machineGroupId,
			allMachines: row.builtIn === 'all',
			permissions: storedPermissionsSchema.parse(JSON.parse(row.permissions)),
			consent: row.consent
		}));
}

/** The union of the rules' permissions, in PERMISSIONS order; unattended if any rule says so. */
function unionOf(rules: MemberRule[]): Grant[] {
	return PERMISSIONS.flatMap((permission) => {
		const giving = rules.filter((rule) => rule.permissions.includes(permission));
		if (giving.length === 0) {
			return [];
		}
		const consent: Consent = giving.some((rule) => rule.consent === 'unattended')
			? 'unattended'
			: 'ask';
		return [{ permission, consent }];
	});
}

export function permissionsFor(database: Queryable, user: ConsoleUser, machineId: string): Grant[] {
	switch (user.role) {
		case 'admin':
			return EVERYTHING;
		case 'member': {
			const rules = rulesFor(database, user.id);
			if (rules.length === 0 || !isActiveMachine(database, machineId)) {
				return [];
			}
			const groupIds = new Set(
				database
					.select({ id: machineGroupMembers.machineGroupId })
					.from(machineGroupMembers)
					.where(eq(machineGroupMembers.machineId, machineId))
					.all()
					.map((row) => row.id)
			);
			return unionOf(rules.filter((rule) => rule.allMachines || groupIds.has(rule.machineGroupId)));
		}
	}
}

/** True when the person may see the machine at all (`view`). Others get 404, not 403 (A6). */
export function canSeeMachine(database: Queryable, user: ConsoleUser, machineId: string): boolean {
	return permissionsFor(database, user, machineId).some((grant) => grant.permission === 'view');
}

/** Every machine the person may see (`view`): the Machines list, Activity and join-code status. */
export function visibleMachineIds(database: Queryable, user: ConsoleUser): Set<string> {
	const active = activeMachineNames(database);
	switch (user.role) {
		case 'admin':
			return new Set(active.keys());
		case 'member': {
			const rules = rulesFor(database, user.id).filter((rule) => rule.permissions.includes('view'));
			if (rules.some((rule) => rule.allMachines)) {
				return new Set(active.keys());
			}
			if (rules.length === 0) {
				return new Set();
			}
			const members = database
				.select({ machineId: machineGroupMembers.machineId })
				.from(machineGroupMembers)
				.where(
					inArray(
						machineGroupMembers.machineGroupId,
						rules.map((rule) => rule.machineGroupId)
					)
				)
				.all();
			return new Set(members.map((row) => row.machineId).filter((id) => active.has(id)));
		}
	}
}

/**
 * Which audit entries the person may read on Activity: every entry for an
 * admin; for a member only those about machines they can see (A6).
 */
export function activityScopeFor(
	database: Queryable,
	user: ConsoleUser
): { kind: 'all' } | { kind: 'machines'; machineIds: string[] } {
	switch (user.role) {
		case 'admin':
			return { kind: 'all' };
		case 'member':
			return { kind: 'machines', machineIds: [...visibleMachineIds(database, user)] };
	}
}
