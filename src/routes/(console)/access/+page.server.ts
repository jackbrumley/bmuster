import { page } from '#lib/server/guards/page.ts';
import {
	prototypeAccessRules,
	prototypeMachineGroups,
	prototypeUserGroups
} from '#lib/prototype/prototype-data.ts';
import type { PageServerLoad } from './$types';

/** PROTOTYPE data until SPEC-ACCESS; admins only. */
export const load: PageServerLoad = page.admin(() => ({
	rules: prototypeAccessRules(),
	userGroups: prototypeUserGroups(),
	machineGroups: prototypeMachineGroups()
}));
