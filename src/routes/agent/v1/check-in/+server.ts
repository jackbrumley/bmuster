import { checkInRequestSchema } from '#lib/schemas/agents/agent-protocol.ts';
import { database } from '#lib/server/database/app-database.ts';
import { authenticateAgent } from '#lib/server/services/agents/agent-auth.ts';
import { isRefusal, refuse, refusalResponse } from '#lib/server/services/agents/agent-refusal.ts';
import { recordCheckIn } from '#lib/server/services/agents/check-in.ts';
import type { RequestHandler } from './$types';

/** POST /agent/v1/check-in: signed, every checkInSeconds (SPEC-ENROLMENT 7). */
export const POST: RequestHandler = async ({ request, url }) => {
	const body = new Uint8Array(await request.arrayBuffer());
	const now = Date.now();
	const agent = authenticateAgent(
		database,
		{
			method: 'POST',
			path: url.pathname,
			authorization: request.headers.get('authorization'),
			body
		},
		now
	);
	if (isRefusal(agent)) {
		return refusalResponse(agent);
	}
	const parsed = checkInRequestSchema.safeParse(JSON.parse(new TextDecoder().decode(body)));
	if (!parsed.success) {
		return refusalResponse(refuse('bad-request', 'The check-in is not valid.'));
	}
	return Response.json(recordCheckIn(database, agent, parsed.data, now));
};
