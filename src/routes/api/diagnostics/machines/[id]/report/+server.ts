import { error } from '@sveltejs/kit';
import { database } from '#lib/server/database/app-database.ts';
import { env } from '#lib/server/env.ts';
import { route } from '#lib/server/guards/route.ts';
import { signedReleases } from '#lib/server/services/agents/releases.ts';
import { machineReport } from '#lib/server/services/logs/diagnostics-reads.ts';
import { noStore } from '../../../diagnostics.server.ts';
import type { RequestHandler } from './$types';

/**
 * GET /api/diagnostics/machines/<id>/report: the machine's latest inventory (with its display
 * report) and status (SPEC-AGENT-LOGS 3, 4). Admins and tokens.
 */
export const GET: RequestHandler = route.diagnostics(({ params }) => {
	const report = machineReport(
		database,
		params.id,
		Date.now(),
		signedReleases(env.releasesPath, env.agentTestBuildsPath)
	);
	if (report === undefined) {
		error(404, 'No machine with this id');
	}
	return noStore(report);
});
