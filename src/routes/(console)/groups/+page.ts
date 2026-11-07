import {
	prototypeMachineGroups,
	prototypeMachines,
	prototypeUserGroups,
	prototypeUsers
} from '#lib/prototype/prototype-data.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = () => {
	const now = Date.now();
	return {
		users: prototypeUsers(now),
		machines: prototypeMachines(),
		userGroups: prototypeUserGroups(),
		machineGroups: prototypeMachineGroups()
	};
};
