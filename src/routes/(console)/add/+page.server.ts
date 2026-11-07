import { database } from '#lib/server/database/app-database.ts';
import { page } from '#lib/server/guards/page.ts';
import { listMachineGroups } from '#lib/server/services/access/groups.ts';
import { installOptions } from './install-options.server.ts';
import type { PageServerLoad } from './$types';

/**
 * Adding a machine makes a join code: admins only. Lists the agent builds for
 * manual installs (M2), in local network mode the certificate pin (L5), and
 * the machine groups a code can put the machine in (SPEC-ACCESS A7).
 */
export const load: PageServerLoad = page.admin(({ url }) => ({
	...installOptions(url.origin),
	machineGroups: listMachineGroups(database)
		.filter((group) => group.membership.kind === 'chosen')
		.map((group) => ({ id: group.id, name: group.name }))
}));
