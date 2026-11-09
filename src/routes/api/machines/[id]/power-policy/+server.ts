import { error } from '@sveltejs/kit';
import { powerPolicyRequestSchema } from '#lib/schemas/machines/power-policy.ts';
import { database } from '#lib/server/database/app-database.ts';
import { route } from '#lib/server/guards/route.ts';
import { sendToAgent } from '#lib/server/services/agents/live-agents.ts';
import { setPowerPolicy } from '#lib/server/services/machines/power-policy.ts';
import { invalidRequest, readJson } from '../../../replies.server.ts';
import type { RequestHandler } from './$types';

/**
 * PUT /api/machines/<id>/power-policy: Stay awake on mains power, on or off (SPEC-STAY-AWAKE).
 * Admins only; origin-checked by the hooks like every write; audited. A connected agent hears it
 * at once, an offline one when it reconnects.
 */
export const PUT: RequestHandler = route.admin(async ({ params, request }, { user }) => {
	const parsed = powerPolicyRequestSchema.safeParse(await readJson(request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	const result = setPowerPolicy(
		database,
		params.id,
		user.id,
		parsed.data.keepAwakeOnAc,
		(message) => sendToAgent(params.id, message),
		Date.now()
	);
	switch (result.kind) {
		case 'not-found':
			return error(404, 'No machine with this id');
		case 'saved':
			return Response.json({ keepAwakeOnAc: result.keepAwakeOnAc, delivered: result.delivered });
	}
});
