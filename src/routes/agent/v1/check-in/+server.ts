import { checkInRequestSchema } from '#lib/schemas/agents/agent-protocol.ts';
import { database } from '#lib/server/database/app-database.ts';
import { env } from '#lib/server/env.ts';
import { route } from '#lib/server/guards/route.ts';
import { refuse, refusalResponse } from '#lib/server/services/agents/agent-refusal.ts';
import { checkInUpdate } from '#lib/server/services/agents/agent-updates.ts';
import { recordCheckIn } from '#lib/server/services/agents/check-in.ts';
import { signedReleases } from '#lib/server/services/agents/releases.ts';
import type { RequestHandler } from './$types';

/**
 * POST /agent/v1/check-in: signed, every checkInSeconds (SPEC-ENROLMENT 7). The reply may offer
 * a newer signed agent build (SPEC-AGENT-UPDATES).
 */
export const POST: RequestHandler = route.agent((_event, { agent, body }) => {
	const parsed = checkInRequestSchema.safeParse(JSON.parse(new TextDecoder().decode(body)));
	if (!parsed.success) {
		return refusalResponse(refuse('bad-request', 'The check-in is not valid.'));
	}
	const now = Date.now();
	const recorded = recordCheckIn(database, agent, parsed.data, now);
	const update = checkInUpdate(
		database,
		agent.machineId,
		parsed.data.agentVersion,
		parsed.data.update,
		signedReleases(env.releasesPath, env.agentTestBuildsPath),
		now
	);
	return Response.json({ ...recorded, update });
});
