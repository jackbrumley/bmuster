import {
	prototypeAccessRules,
	prototypeMachineGroups,
	prototypeUserGroups
} from '#lib/prototype/prototype-data.ts';
import type { PageLoad } from './$types';

export const load: PageLoad = () => ({
	rules: prototypeAccessRules(),
	userGroups: prototypeUserGroups(),
	machineGroups: prototypeMachineGroups()
});
