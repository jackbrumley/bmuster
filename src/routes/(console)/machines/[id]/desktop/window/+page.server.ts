import { error } from '@sveltejs/kit';
import { hasPermission } from '#lib/domain/access/access.ts';
import { database } from '#lib/server/database/app-database.ts';
import { env } from '#lib/server/env.ts';
import { page } from '#lib/server/guards/page.ts';
import { permissionsFor } from '#lib/server/services/access/access.ts';
import { signedReleases } from '#lib/server/services/agents/releases.ts';
import { findMachine } from '#lib/server/services/machines/machine-views.ts';
import type { PageServerLoad } from './$types';

/**
 * The desktop popped out into its own window (SPEC-DESKTOP-POPOUT 13). The
 * page resets to the root layout, so the console's and the machine's
 * layout loads do not run: this load makes their checks itself. A hidden
 * machine is 404, as everywhere (SPEC-ACCESS A6); a person who may see it
 * but not its screen gets 403.
 */
export const load: PageServerLoad = page.user(({ params }, { user }) => {
	const grants = permissionsFor(database, user, params.id);
	if (!hasPermission(grants, 'view')) {
		error(404, 'No machine with this id');
	}
	if (!hasPermission(grants, 'desktop-view')) {
		error(403, 'You do not have access to this desktop.');
	}
	const machine = findMachine(
		database,
		params.id,
		Date.now(),
		signedReleases(env.releasesPath, env.agentTestBuildsPath)
	);
	if (machine === undefined) {
		error(404, 'No machine with this id');
	}
	return { machine, grants };
});
