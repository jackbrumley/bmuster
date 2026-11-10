import { machinesExportQuerySchema } from '#lib/schemas/exports/exports.ts';
import { database } from '#lib/server/database/app-database.ts';
import { env } from '#lib/server/env.ts';
import { route } from '#lib/server/guards/route.ts';
import { csvResponse } from '#lib/server/services/exports/csv.ts';
import { exportMachines } from '#lib/server/services/exports/exports.ts';
import { signedReleases } from '#lib/server/services/agents/releases.ts';
import { invalidRequest } from '../../replies.server.ts';
import type { RequestHandler } from './$types';

/**
 * GET /api/exports/machines: every machine the person may see that matches
 * the page's search and filter, in its order (SPEC-CSV-EXPORT X5, X6).
 */
export const GET: RequestHandler = route.user(({ url }, { user }) => {
	const query = machinesExportQuerySchema.safeParse(Object.fromEntries(url.searchParams));
	if (!query.success) {
		return invalidRequest(query.error);
	}
	return csvResponse(
		exportMachines(
			database,
			user,
			query.data,
			Date.now(),
			signedReleases(env.releasesPath, env.agentTestBuildsPath)
		)
	);
});
