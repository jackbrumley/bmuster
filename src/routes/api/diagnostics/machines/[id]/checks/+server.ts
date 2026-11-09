import { error } from '@sveltejs/kit';
import { database } from '#lib/server/database/app-database.ts';
import { route } from '#lib/server/guards/route.ts';
import { readMachineChecks } from '#lib/server/services/logs/machine-checks.ts';
import { noStore } from '../../../diagnostics.server.ts';
import type { RequestHandler } from './$types';

/**
 * GET /api/diagnostics/machines/<id>/checks: the agent's latest self-check results
 * (SPEC-DIAGNOSTICS 1). Admins and tokens; reading never runs them.
 */
export const GET: RequestHandler = route.diagnostics(({ params }) => {
	const checks = readMachineChecks(database, params.id);
	if (checks === undefined) {
		error(404, 'No machine with this id');
	}
	return noStore(checks);
});
