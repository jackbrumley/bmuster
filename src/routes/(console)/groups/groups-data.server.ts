import { database } from '#lib/server/database/app-database.ts';
import { listMachineGroups, listUserGroups } from '#lib/server/services/access/groups.ts';
import { listAccessRules } from '#lib/server/services/access/rules.ts';
import { activeMachineNames } from '#lib/server/services/machines/machine-views.ts';
import { listUsers } from '#lib/server/services/users/users.ts';

/**
 * Groups of people and groups of machines (SPEC-ACCESS A1–A3, A8); admins
 * only (the pages' guard). Both tabs load the same data: a section names the other kind's groups
 * in the rules it lists, and the rules come along so deleting a group can name
 * the ones it takes.
 */
export function groupsData() {
	return {
		userGroups: listUserGroups(database),
		machineGroups: listMachineGroups(database),
		rules: listAccessRules(database),
		people: listUsers(database).map((user) => ({
			id: user.id,
			label: user.name,
			detail: user.email
		})),
		machines: [...activeMachineNames(database)].map(([id, name]) => ({
			id,
			label: name,
			detail: ''
		}))
	};
}
