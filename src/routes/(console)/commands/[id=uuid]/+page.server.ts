import { error } from '@sveltejs/kit';
import { database } from '#lib/server/database/app-database.ts';
import { page } from '#lib/server/guards/page.ts';
import { runViewFor } from '#lib/server/services/commands/run-views.ts';
import type { PageServerLoad } from './$types';

/**
 * A run's results (SPEC-COMMANDS C16): only the machines the person can view; a run with none
 * of them is not found. The page then follows the run live.
 */
export const load: PageServerLoad = page.user(({ params }, { user }) => {
	const run = runViewFor(database, user, params.id);
	if (run === undefined) {
		error(404, 'No command run with this id.');
	}
	return { now: Date.now(), run };
});
