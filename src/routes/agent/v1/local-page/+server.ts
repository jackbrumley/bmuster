import { localPageReportSchema } from '#lib/schemas/agents/agent-protocol.ts';
import { database } from '#lib/server/database/app-database.ts';
import { env } from '#lib/server/env.ts';
import { route } from '#lib/server/guards/route.ts';
import { refuse, refusalResponse } from '#lib/server/services/agents/agent-refusal.ts';
import { storeLocalPage } from '#lib/server/services/agents/local-page.ts';
import type { RequestHandler } from './$types';

/** POST /agent/v1/local-page: signed; the local page's sign-in secret and certificate (SPEC-AGENT-LOCAL). */
export const POST: RequestHandler = route.agent((_event, { agent, body }) => {
	const parsed = localPageReportSchema.safeParse(JSON.parse(new TextDecoder().decode(body)));
	if (!parsed.success) {
		return refusalResponse(refuse('bad-request', 'The local page report is not valid.'));
	}
	storeLocalPage(database, agent, parsed.data, env.secretsKey, Date.now());
	return Response.json({ stored: true });
});
