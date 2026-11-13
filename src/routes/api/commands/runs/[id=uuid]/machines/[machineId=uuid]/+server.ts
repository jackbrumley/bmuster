import { database } from '#lib/server/database/app-database.ts';
import { route } from '#lib/server/guards/route.ts';
import { runOutputFor } from '#lib/server/services/commands/run-views.ts';
import type { RequestHandler } from './$types';

/**
 * GET /api/commands/runs/<id>/machines/<machineId>: one machine's output (SPEC-COMMANDS C16),
 * only for a person who can view that machine. Output can hold secrets; it is never in a list.
 */
export const GET: RequestHandler = route.user(({ params }, { user }) => {
	const output = runOutputFor(database, user, params.id, params.machineId);
	return output === undefined
		? Response.json({ message: 'No output for this machine in this run.' }, { status: 404 })
		: Response.json(output);
});
