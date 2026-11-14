import { unattendedRequestSchema } from '#lib/schemas/mcp/console.ts';
import { database } from '#lib/server/database/app-database.ts';
import { route } from '#lib/server/guards/route.ts';
import { writeUnattendedAllowed } from '#lib/server/services/oauth/mcp-settings.ts';
import { invalidRequest, readJson } from '../../replies.server.ts';
import type { RequestHandler } from './$types';

/**
 * PUT /api/mcp/unattended: Allow AI to run saved commands without approval (admins;
 * SPEC-SAVED-COMMANDS SC21). Audited when it changes.
 */
export const PUT: RequestHandler = route.admin(async ({ request }, { user }) => {
	const parsed = unattendedRequestSchema.safeParse(await readJson(request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	writeUnattendedAllowed(database, user.id, parsed.data.allowed, Date.now());
	return Response.json({ allowed: parsed.data.allowed });
});
