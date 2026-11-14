import { database } from '#lib/server/database/app-database.ts';
import { route } from '#lib/server/guards/route.ts';
import { appRunner } from '#lib/server/services/commands/app-runner.ts';
import { settleEndedGrantRuns } from '#lib/server/services/commands/assistant-pending.ts';
import { stopAllAiAccess } from '#lib/server/services/oauth/grants.ts';
import type { RequestHandler } from './$types';

/**
 * POST /api/mcp/stop-all: Stop all AI access (admins; SPEC-MCP M14, M29). MCP off, every grant
 * ended, then every request waiting for approval cancelled and the machines not started of
 * running assistant runs.
 */
export const POST: RequestHandler = route.admin((_event, { user }) => {
	const now = Date.now();
	const grantsEnded = stopAllAiAccess(database, user.id, now);
	const runsCancelled = settleEndedGrantRuns({ database, runner: appRunner(), now });
	return Response.json({ grantsEnded, runsCancelled });
});
