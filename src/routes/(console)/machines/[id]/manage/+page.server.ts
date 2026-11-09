import { database } from '#lib/server/database/app-database.ts';
import { page } from '#lib/server/guards/page.ts';
import { listMachineGroups } from '#lib/server/services/access/groups.ts';
import { localPageInfo } from '#lib/server/services/agents/local-page.ts';
import { verboseUntil } from '#lib/server/services/logs/verbose.ts';
import { installOptions } from '../../../add/install-options.server.ts';
import type { PageServerLoad } from './$types';

/**
 * Manage: Reinstall agent shows the same install commands as Add machine (SPEC-MACHINE-DETAILS D9);
 * Local page shows the agent's local page address and certificate (SPEC-AGENT-LOCAL); Groups
 * lists the machine groups it can be in (SPEC-ACCESS A2); Logs starts from the machine's verbose
 * deadline, if it has one (SPEC-AGENT-LOGS 4).
 */
export const load: PageServerLoad = page.admin(({ url, params }) => {
	const until = verboseUntil(database, params.id, Date.now());
	return {
		...installOptions(url.origin),
		localPage: localPageInfo(database, params.id),
		machineGroups: listMachineGroups(database),
		verboseUntilIso: until === null ? null : new Date(until).toISOString()
	};
});
