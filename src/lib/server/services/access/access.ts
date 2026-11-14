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
import { enabledAdmins } from '../users/users.ts';

/**
 * The one answer to "what may this person do on this machine" (SPEC-ACCESS
 * A5, AGENTS.md §11). Admins have every permission on every machine and
 * connect unattended, except `ai-commands` (SPEC-MCP M3): an AI assistant sees a machine only
 * where a rule says so, admins included. A member has the union of every rule whose user group
 * they are in and whose machine group holds the machine; a permission is
 * unattended when any rule giving it says so. Removed machines give nothing.
 */

type MemberRule = {
	machineGroupId: string;
	allMachines: boolean;
	permissions: Permission[];
	consent: Consent;
};

/** Permissions that come only from rules, for admins too (SPEC-MCP M3). */
const RULES_ONLY: readonly Permission[] = ['ai-commands'];

const ADMIN_DEFAULTS: Grant[] = PERMISSIONS.filter(
	(permission) => !RULES_ONLY.includes(permission)
).map((permission) => ({ permission, consent: 'unattended' }));

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

/** The union of the person's own rules that reach this machine; nothing for a removed one. */
function rulesGrantsFor(database: Queryable, userId: string, machineId: string): Grant[] {
	const rules = rulesFor(database, userId);
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

export function permissionsFor(database: Queryable, user: ConsoleUser, machineId: string): Grant[] {
	switch (user.role) {
		case 'admin': {
			const fromRules = rulesGrantsFor(database, user.id, machineId).filter((grant) =>
				RULES_ONLY.includes(grant.permission)
			);
			return PERMISSIONS.flatMap((permission) => [
				...ADMIN_DEFAULTS.filter((grant) => grant.permission === permission),
				...fromRules.filter((grant) => grant.permission === permission)
			]);
		}
		case 'member':
			return rulesGrantsFor(database, user.id, machineId);
	}
}

/** True when the person may see the machine at all (`view`). Others get 404, not 403 (A6). */
export function canSeeMachine(database: Queryable, user: ConsoleUser, machineId: string): boolean {
	return permissionsFor(database, user, machineId).some((grant) => grant.permission === 'view');
}

/** Every machine the person may see (`view`): the Machines list, Activity and join-code status. */
export function visibleMachineIds(database: Queryable, user: ConsoleUser): Set<string> {
	return machineIdsWith(database, user, 'view');
}

/**
 * The machine groups a person picks from in the Machines page's select mode (SPEC-COMMANDS
 * C2): every group for an admin; for a member only the groups their own rules giving
 * `run-commands` name, since members do not see the Groups page (A1–A3).
 */
export function commandGroupIdsFor(
	database: Queryable,
	user: ConsoleUser
): { kind: 'all' } | { kind: 'some'; groupIds: Set<string> } {
	switch (user.role) {
		case 'admin':
			return { kind: 'all' };
		case 'member':
			return {
				kind: 'some',
				groupIds: new Set(
					rulesFor(database, user.id)
						.filter((rule) => rule.permissions.includes('run-commands'))
						.map((rule) => rule.machineGroupId)
				)
			};
	}
}

/**
 * Every machine on which the person holds `permission`: `view` for the Machines list,
 * `run-commands` for the Machines page's select mode (SPEC-COMMANDS C5), `ai-commands` for what
 * an AI assistant may see (SPEC-MCP M11), which admins hold only through rules.
 */
export function machineIdsWith(
	database: Queryable,
	user: ConsoleUser,
	permission: Permission
): Set<string> {
	const active = activeMachineNames(database);
	if (user.role === 'admin' && !RULES_ONLY.includes(permission)) {
		return new Set(active.keys());
	}
	const rules = rulesFor(database, user.id).filter((rule) => rule.permissions.includes(permission));
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

/**
 * True when the person may see group names and members: the Groups page is
 * admins only (A1–A3), so a member's Machines export leaves the column out.
 */
export function canSeeGroups(user: ConsoleUser): boolean {
	switch (user.role) {
		case 'admin':
			return true;
		case 'member':
			return false;
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

/**
 * Who may sign in to a machine's local page with their own code (SPEC-AGENT-LOCAL 7), in
 * userId order: admins who are not disabled. Later, whoever the access rules allow.
 */
export function localPagePeople(database: Queryable): { userId: string; name: string }[] {
	return enabledAdmins(database).map((admin) => ({ userId: admin.id, name: admin.name }));
}

/**
 * Reading agent and server logs and machine reports, making an agent verbose, and diagnostics
 * tokens (SPEC-AGENT-LOGS 4) are for admins only.
 */
export function canReadDiagnostics(user: ConsoleUser): boolean {
	switch (user.role) {
		case 'admin':
			return true;
		case 'member':
			return false;
	}
}

/** Managing the server and viewing release/update metadata is admin-only. */
export function canManageServer(user: ConsoleUser): boolean {
	return user.role === 'admin';
}
