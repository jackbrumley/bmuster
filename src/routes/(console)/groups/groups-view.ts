import { builtInGroupAbout } from '#lib/domain/access/access.ts';
import { describeRule } from '../access/rule-names.ts';
import type { PageData } from './$types';

/** What both Groups tabs load (groups-data.server.ts). */
type GroupsData = Pick<PageData, 'userGroups' | 'machineGroups' | 'rules'>;

/** Groups of people as the group section shows them. */
export function userGroupRows(data: GroupsData) {
	return data.userGroups.map((group) => ({
		id: group.id,
		name: group.name,
		description: group.description,
		about: undefined,
		membership: { kind: 'chosen' as const, memberIds: group.memberIds }
	}));
}

/** Groups of machines as the group section shows them; built-in groups explain themselves. */
export function machineGroupRows(data: GroupsData) {
	return data.machineGroups.map((group) => ({
		id: group.id,
		name: group.name,
		description: group.description,
		about: group.builtIn === 'none' ? undefined : builtInGroupAbout(group.builtIn),
		membership:
			group.membership.kind === 'all-machines'
				? { kind: 'all-machines' as const }
				: { kind: 'chosen' as const, memberIds: group.membership.machineIds }
	}));
}

/** The access rules that name a group, in words, so deleting it can say what goes with it. */
export function rulesUsing(data: GroupsData, groupId: string): string[] {
	return data.rules
		.filter((rule) => rule.userGroupId === groupId || rule.machineGroupId === groupId)
		.map((rule) => describeRule(rule, data.userGroups, data.machineGroups));
}
