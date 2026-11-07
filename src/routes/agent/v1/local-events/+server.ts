import { localEventsReportSchema } from '#lib/schemas/agents/agent-protocol.ts';
import { database } from '#lib/server/database/app-database.ts';
import { route } from '#lib/server/guards/route.ts';
import { refuse, refusalResponse } from '#lib/server/services/agents/agent-refusal.ts';
import { recordLocalEvents } from '#lib/server/services/agents/local-events.ts';
import type { RequestHandler } from './$types';

/** POST /agent/v1/local-events: signed; what happened on the agent's local page, for Activity (SPEC-AGENT-LOCAL 7). */
export const POST: RequestHandler = route.agent((_event, { agent, body }) => {
	const parsed = localEventsReportSchema.safeParse(JSON.parse(new TextDecoder().decode(body)));
	if (!parsed.success) {
		return refusalResponse(refuse('bad-request', 'The local events report is not valid.'));
	}
	return Response.json({ recorded: recordLocalEvents(database, agent, parsed.data, Date.now()) });
});
