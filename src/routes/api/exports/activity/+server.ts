import { activityExportQuerySchema } from '#lib/schemas/exports/exports.ts';
import { database } from '#lib/server/database/app-database.ts';
import { route } from '#lib/server/guards/route.ts';
import { csvResponse } from '#lib/server/services/exports/csv.ts';
import { exportActivity } from '#lib/server/services/exports/exports.ts';
import { invalidRequest } from '../../replies.server.ts';
import type { RequestHandler } from './$types';

/**
 * GET /api/exports/activity: the audit entries the person may read, newest
 * first, capped (SPEC-CSV-EXPORT X5, X7).
 */
export const GET: RequestHandler = route.user(({ url }, { user }) => {
	const query = activityExportQuerySchema.safeParse(Object.fromEntries(url.searchParams));
	if (!query.success) {
		return invalidRequest(query.error);
	}
	return csvResponse(exportActivity(database, user, query.data, Date.now()));
});
