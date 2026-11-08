import { serverUpdates } from '#lib/server/services/server-updates/live.ts';
import { AGENT_TARGETS } from '#lib/domain/machines/agent-release.ts';
import { database } from '#lib/server/database/app-database.ts';
import { env } from '#lib/server/env.ts';
import { page } from '#lib/server/guards/page.ts';
import {
	earlyUpdatesGroup,
	newestVersion,
	rolloutView
} from '#lib/server/services/agents/agent-updates.ts';
import { listReleases, signedReleases } from '#lib/server/services/agents/releases.ts';
import { listMachines } from '#lib/server/services/machines/machine-views.ts';
import { getSetting } from '#lib/server/services/settings/settings.ts';
import type { PageServerLoad } from './$types';

/**
 * Updates (SPEC-AGENT-UPDATES): the version on offer, the roll-out, every machine's agent version
 * and update state, and the builds on this server. Admins only.
 */
export const load: PageServerLoad = page.admin(() => {
	const now = Date.now();
	const releases = signedReleases(env.releasesPath);
	const newest = newestVersion(releases, AGENT_TARGETS);
	return {
		now,
		server: serverUpdates().view(),
		policy: getSetting(database, 'agentUpdatePolicy'),
		rollout: rolloutView(database, newest?.version, now),
		earlyGroup: earlyUpdatesGroup(database),
		builds: listReleases(env.releasesPath, AGENT_TARGETS),
		machines: listMachines(database, now, releases).map((machine) => ({
			id: machine.id,
			name: machine.name,
			osFamily: machine.osFamily,
			agentVersion: machine.agentVersion,
			status: machine.status,
			update: machine.update
		}))
	};
});
