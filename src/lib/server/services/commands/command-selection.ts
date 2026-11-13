import type { CommandSelection, SelectGroup } from '#lib/domain/commands/commands.ts';
import type { MachineGroupView } from '#lib/domain/access/access.ts';
import type { ConsoleUser } from '#lib/domain/users/user.ts';
import type { Queryable } from '../../database/connection.ts';
import { commandGroupIdsFor, machineIdsWith } from '../access/access.ts';
import { listMachineGroups } from '../access/groups.ts';

/**
 * What the Machines page's select mode needs (SPEC-COMMANDS C1–C5): the machines the person may
 * run commands on, and the machine groups to narrow by, each with only machines they can see.
 * The browser uses it to draw tick boxes; the server checks every run again (C12).
 */
export function commandSelectionFor(
	database: Queryable,
	user: ConsoleUser,
	visible: ReadonlySet<string>
): CommandSelection {
	const runnable = [...machineIdsWith(database, user, 'run-commands')].filter((id) =>
		visible.has(id)
	);
	if (runnable.length === 0) {
		return { kind: 'none' };
	}
	const allowed = commandGroupIdsFor(database, user);
	const groups = listMachineGroups(database).filter((group) =>
		allowed.kind === 'all' ? true : allowed.groupIds.has(group.id)
	);
	// The built-in All machines group first (C2), then the rest in the Groups page's order.
	const ordered = [
		...groups.filter((group) => group.builtIn === 'all'),
		...groups.filter((group) => group.builtIn !== 'all')
	];
	return { kind: 'allowed', runnable, groups: ordered.map((group) => chip(group, visible)) };
}

function chip(group: MachineGroupView, visible: ReadonlySet<string>): SelectGroup {
	switch (group.membership.kind) {
		case 'all-machines':
			return { id: group.id, name: group.name, machineIds: [...visible] };
		case 'chosen':
			return {
				id: group.id,
				name: group.name,
				machineIds: group.membership.machineIds.filter((id) => visible.has(id))
			};
	}
}
