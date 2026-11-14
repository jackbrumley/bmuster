import { database } from '#lib/server/database/app-database.ts';
import { route } from '#lib/server/guards/route.ts';
import { appRunner } from '#lib/server/services/commands/app-runner.ts';
import { runViewFor } from '#lib/server/services/commands/run-views.ts';
import type { RequestHandler } from './$types';

/** GET /api/commands/runs/<id>: one run's results, its machines filtered by `view` (SPEC-COMMANDS C16). */
export const GET: RequestHandler = route.user(({ params }, { user }) => {
	const view = runViewFor(database, user, params.id, appRunner());
	return view === undefined
		? Response.json({ message: 'No command run with this id.' }, { status: 404 })
		: Response.json(view);
});
