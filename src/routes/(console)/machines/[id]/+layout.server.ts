import { error } from '@sveltejs/kit';
import { database } from '#lib/server/database/app-database.ts';
import { env } from '#lib/server/env.ts';
import { page } from '#lib/server/guards/page.ts';
import { signedReleases } from '#lib/server/services/agents/releases.ts';
import { permissionsFor } from '#lib/server/services/access/access.ts';
import { watchAgent } from '#lib/server/services/agents/live-agents.ts';
import { findMachine } from '#lib/server/services/machines/machine-views.ts';
import type { LayoutServerLoad } from './$types';

/**
 * A machine's pages, for anyone who may see it (SPEC-ACCESS A6). Everyone
 * else gets 404, so a member cannot tell a hidden machine from a missing one.
 * `grants` say which tabs the person may use.
 */
export const load: LayoutServerLoad = page.user(({ params }, { user }) => {
	const grants = permissionsFor(database, user, params.id);
	if (!grants.some((grant) => grant.permission === 'view')) {
		error(404, 'No machine with this id');
	}
	const now = Date.now();
	const machine = findMachine(
		database,
		params.id,
		now,
		signedReleases(env.releasesPath, env.agentTestBuildsPath)
	);
	if (machine === undefined) {
		error(404, 'No machine with this id');
	}
	watchAgent(machine.id);
	return { now, machine, grants };
});
