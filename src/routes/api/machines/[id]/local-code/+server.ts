import { error } from '@sveltejs/kit';
import { database } from '#lib/server/database/app-database.ts';
import { env } from '#lib/server/env.ts';
import { route } from '#lib/server/guards/route.ts';
import { viewLocalCode } from '#lib/server/services/agents/local-page.ts';
import type { RequestHandler } from './$types';

/**
 * POST /api/machines/<id>/local-code: the agent's local page code now and the seconds until it
 * changes (SPEC-AGENT-LOCAL). Admins; audited. POST because each view may write the audit log.
 */
export const POST: RequestHandler = route.admin(({ params }, { user }) => {
	const reply = viewLocalCode(database, params.id, user.id, env.secretsKey, Date.now());
	if (reply === undefined) {
		error(404, 'No machine with this id');
	}
	return Response.json(reply);
});
