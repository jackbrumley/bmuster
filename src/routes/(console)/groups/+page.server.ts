import { page } from '#lib/server/guards/page.ts';
import {
	prototypeMachineGroups,
	prototypeMachines,
	prototypeUserGroups,
	prototypeUsers
} from '#lib/prototype/prototype-data.ts';
import type { PageServerLoad } from './$types';

/** PROTOTYPE data until SPEC-ACCESS; admins only. */
export const load: PageServerLoad = page.admin(() => {
	const now = Date.now();
	return {
		users: prototypeUsers(now),
		machines: prototypeMachines(),
		userGroups: prototypeUserGroups(),
		machineGroups: prototypeMachineGroups()
	};
});
