import { leaveRequestSchema } from '#lib/schemas/agents/agent-protocol.ts';
import { database } from '#lib/server/database/app-database.ts';
import { route } from '#lib/server/guards/route.ts';
import { refuse, refusalResponse } from '#lib/server/services/agents/agent-refusal.ts';
import { recordLeave } from '#lib/server/services/agents/leave.ts';
import type { RequestHandler } from './$types';

/** POST /agent/v1/leave: signed; the machine moved or is uninstalled and is refused from now on (SPEC-AGENT-LOCAL). */
export const POST: RequestHandler = route.agent((_event, { agent, body }) => {
	const parsed = leaveRequestSchema.safeParse(JSON.parse(new TextDecoder().decode(body)));
	if (!parsed.success) {
		return refusalResponse(refuse('bad-request', 'The leave request is not valid.'));
	}
	recordLeave(database, agent, parsed.data.reason, Date.now());
	return Response.json({ left: true });
});
