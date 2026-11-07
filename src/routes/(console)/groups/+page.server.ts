import { database } from '#lib/server/database/app-database.ts';
import { page } from '#lib/server/guards/page.ts';
import { listMachineGroups, listUserGroups } from '#lib/server/services/access/groups.ts';
import { listAccessRules } from '#lib/server/services/access/rules.ts';
import { activeMachineNames } from '#lib/server/services/machines/machine-views.ts';
import { listUsers } from '#lib/server/services/users/users.ts';
import type { PageServerLoad } from './$types';

/**
 * Groups of people and groups of machines (SPEC-ACCESS A1–A3, A8); admins
 * only. The rules come along so deleting a group can name the ones it takes.
 */
export const load: PageServerLoad = page.admin(() => ({
	userGroups: listUserGroups(database),
	machineGroups: listMachineGroups(database),
	rules: listAccessRules(database),
	people: listUsers(database).map((user) => ({
		id: user.id,
		label: user.name,
		detail: user.email
	})),
	machines: [...activeMachineNames(database)].map(([id, name]) => ({ id, label: name, detail: '' }))
}));
