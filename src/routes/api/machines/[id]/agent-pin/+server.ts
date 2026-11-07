import { error } from '@sveltejs/kit';
import { agentPinRequestSchema } from '#lib/schemas/machines/agent-updates.ts';
import { database } from '#lib/server/database/app-database.ts';
import { route } from '#lib/server/guards/route.ts';
import { setPinned } from '#lib/server/services/agents/agent-updates.ts';
import { invalidRequest, readJson } from '../../../replies.server.ts';
import type { RequestHandler } from './$types';

/**
 * PATCH /api/machines/<id>/agent-pin (SPEC-AGENT-UPDATES): pin a machine to its agent version, or
 * unpin it. Admins; audited.
 */
export const PATCH: RequestHandler = route.admin(async ({ params, request }, { user }) => {
	const parsed = agentPinRequestSchema.safeParse(await readJson(request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	if (!setPinned(database, params.id, parsed.data.pinned, user.id, Date.now())) {
		error(404, 'No machine with this id');
	}
	return Response.json({ pinned: parsed.data.pinned });
});
