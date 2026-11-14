import { withIncluded, type Permission } from '#lib/domain/access/access.ts';
import type { AiAccessView } from '#lib/domain/mcp/mcp.ts';
import type { AppDatabase, Queryable } from '../../database/connection.ts';
import { listMachineGroups } from '../access/groups.ts';
import { createRule, listAccessRules, newRuleDefaults, updateRule } from '../access/rules.ts';
import { activeMachineNames } from '../machines/machine-views.ts';
import { readMcpSettings } from './mcp-settings.ts';

/**
 * What AI assistants can reach, on Settings → AI assistants (SPEC-SAVED-COMMANDS SC24, SC25):
 * how many machines the rules of the group who may connect an assistant open to AI can view and
 * to AI commands, and one-tap rules giving that group either on All machines. The rules go
 * through the access rules service, so they are checked and audited like any other.
 */

/** The machines this group's rules give a permission on. */
function machinesWith(database: Queryable, userGroupId: string, permission: Permission): number {
	const groupIds = new Set(
		listAccessRules(database)
			.filter((rule) => rule.userGroupId === userGroupId && rule.permissions.includes(permission))
			.map((rule) => rule.machineGroupId)
	);
	const groups = listMachineGroups(database).filter((group) => groupIds.has(group.id));
	if (groups.some((group) => group.membership.kind === 'all-machines')) {
		return activeMachineNames(database).size;
	}
	return new Set(
		groups.flatMap((group) =>
			group.membership.kind === 'chosen' ? group.membership.machineIds : []
		)
	).size;
}

function allMachinesGroupId(database: Queryable): string {
	const all = listMachineGroups(database).find((group) => group.builtIn === 'all');
	if (all === undefined) {
		throw new Error('The built-in All machines group is missing; run the migrations.');
	}
	return all.id;
}

/** The connect group's rule on All machines, if there is one. */
function allMachinesRule(database: Queryable, userGroupId: string) {
	const allId = allMachinesGroupId(database);
	return listAccessRules(database).find(
		(rule) => rule.userGroupId === userGroupId && rule.machineGroupId === allId
	);
}

export function aiAccessView(database: Queryable): AiAccessView {
	const groupId = readMcpSettings(database).userGroupId;
	if (groupId === null) {
		return { kind: 'no-group' };
	}
	const rule = allMachinesRule(database, groupId);
	return {
		kind: 'group',
		canView: machinesWith(database, groupId, 'ai-view'),
		canAsk: machinesWith(database, groupId, 'ai-commands'),
		viewsAll: rule?.permissions.includes('ai-view') === true,
		asksAll: rule?.permissions.includes('ai-commands') === true
	};
}

/**
 * Gives the connect group AI can view (`view`) or AI commands (`commands`) on All machines: a new
 * rule, or the permissions added to the rule the pair already has (one rule per pair).
 */
export function grantAiAccess(
	database: AppDatabase,
	actorUserId: string,
	level: 'view' | 'commands',
	now: number
): { kind: 'done' } | { kind: 'refused'; status: 400 | 404 | 409; message: string } {
	const groupId = readMcpSettings(database).userGroupId;
	if (groupId === null) {
		return {
			kind: 'refused',
			status: 400,
			message: 'Choose who may connect an AI assistant first.'
		};
	}
	const wanted: Permission[] = level === 'view' ? ['view', 'ai-view'] : ['view', 'ai-commands'];
	const rule = allMachinesRule(database, groupId);
	const change =
		rule === undefined
			? createRule(
					database,
					actorUserId,
					{
						userGroupId: groupId,
						machineGroupId: allMachinesGroupId(database),
						permissions: withIncluded(wanted),
						consent: newRuleDefaults(database).consent
					},
					now
				)
			: updateRule(
					database,
					actorUserId,
					rule.id,
					{
						userGroupId: rule.userGroupId,
						machineGroupId: rule.machineGroupId,
						permissions: withIncluded([...rule.permissions, ...wanted]),
						consent: rule.consent
					},
					now
				);
	return change.kind === 'done' ? { kind: 'done' } : change;
}
