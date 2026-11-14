import { database } from '#lib/server/database/app-database.ts';
import { env } from '#lib/server/env.ts';
import { route } from '#lib/server/guards/route.ts';
import { signedReleases } from '#lib/server/services/agents/releases.ts';
import { serverLog } from '#lib/server/services/logs/server-log.ts';
import { serveMcp } from '#lib/server/services/mcp/mcp-endpoint.ts';
import type { RequestHandler } from './$types';

/**
 * POST /mcp (SPEC-MCP M4, 7.2): an AI assistant's requests, as the person behind its token.
 * Stateless, so GET (a listening stream) and DELETE (ending a session) answer 405.
 */
export const POST: RequestHandler = route.mcp(({ request }, { principal }) =>
	serveMcp(
		request,
		{
			database,
			principal,
			releases: signedReleases(env.releasesPath, env.agentTestBuildsPath),
			now: Date.now()
		},
		(caught) => {
			serverLog('warn', 'http', `MCP request refused: ${caught.message}`);
		}
	)
);

function notAllowed(): Response {
	return Response.json(
		{ message: 'BMuster keeps no MCP sessions: send requests with POST.' },
		{ status: 405, headers: { allow: 'POST' } }
	);
}

export const GET: RequestHandler = route.mcp(notAllowed);
export const DELETE: RequestHandler = route.mcp(notAllowed);
