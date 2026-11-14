import { database } from '#lib/server/database/app-database.ts';
import { route } from '#lib/server/guards/route.ts';
import { stopAllAiAccess } from '#lib/server/services/oauth/grants.ts';
import type { RequestHandler } from './$types';

/** POST /api/mcp/stop-all: Stop all AI access (admins; SPEC-MCP M14). MCP off, every grant ended. */
export const POST: RequestHandler = route.admin((_event, { user }) =>
	Response.json({ grantsEnded: stopAllAiAccess(database, user.id, Date.now()) })
);
