import { error } from '@sveltejs/kit';
import { VERBOSE_FOR_MS } from '#lib/domain/logs/logs.ts';
import { verboseRequestSchema } from '#lib/schemas/logs/logs.ts';
import { database } from '#lib/server/database/app-database.ts';
import { route } from '#lib/server/guards/route.ts';
import { sendToAgent } from '#lib/server/services/agents/live-agents.ts';
import { setVerbose } from '#lib/server/services/logs/verbose.ts';
import { invalidRequest, readJson } from '../../../replies.server.ts';
import type { RequestHandler } from './$types';

/**
 * POST /api/machines/<id>/verbose: the agent logs its own debug records for an hour, or stops
 * (SPEC-AGENT-LOGS 1). Admins; audited. An offline agent hears it when it reconnects.
 */
export const POST: RequestHandler = route.admin(async ({ params, request }, { user }) => {
	const parsed = verboseRequestSchema.safeParse(await readJson(request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	const result = setVerbose(
		database,
		params.id,
		user.id,
		parsed.data.kind === 'hour' ? { kind: 'for', durationMs: VERBOSE_FOR_MS } : { kind: 'stop' },
		(message) => sendToAgent(params.id, message),
		Date.now()
	);
	switch (result.kind) {
		case 'not-found':
			return error(404, 'No machine with this id');
		case 'set':
			return Response.json({
				untilIso: result.untilMs === null ? null : new Date(result.untilMs).toISOString(),
				delivered: result.delivered
			});
	}
});
