import type { AccessRuleView } from '#lib/domain/access/access.ts';

type Named = { id: string; name: string };

/** A group's name; the page's data always holds every group a rule points at. */
export function groupName(groups: readonly Named[], id: string): string {
	const group = groups.find((candidate) => candidate.id === id);
	if (group === undefined) {
		throw new Error(`Access rule points at a missing group: ${id}`);
	}
	return group.name;
}

/** "IT → Office", as the Groups page names the rules a deletion takes with it (A8). */
export function describeRule(
	rule: Pick<AccessRuleView, 'userGroupId' | 'machineGroupId'>,
	userGroups: readonly Named[],
	machineGroups: readonly Named[]
): string {
	return `${groupName(userGroups, rule.userGroupId)} → ${groupName(machineGroups, rule.machineGroupId)}`;
}
