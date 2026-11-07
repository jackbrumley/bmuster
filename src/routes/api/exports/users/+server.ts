import { database } from '#lib/server/database/app-database.ts';
import { route } from '#lib/server/guards/route.ts';
import { csvResponse } from '#lib/server/services/exports/csv.ts';
import { exportUsers } from '#lib/server/services/exports/exports.ts';
import type { RequestHandler } from './$types';

/** GET /api/exports/users: Users as CSV; admins only (SPEC-CSV-EXPORT X5). */
export const GET: RequestHandler = route.admin((_event, { user }) =>
	csvResponse(exportUsers(database, user, Date.now()))
);
