import { database } from '#lib/server/database/app-database.ts';
import { route } from '#lib/server/guards/route.ts';
import { appRunner } from '#lib/server/services/commands/app-runner.ts';
import { settleEndedGrantRuns } from '#lib/server/services/commands/assistant-pending.ts';
import { disconnectGrant } from '#lib/server/services/oauth/grants.ts';
import type { RequestHandler } from './$types';

/**
 * DELETE /api/mcp/grants/<id>: Disconnect an AI assistant (SPEC-MCP M10). A person's own on the
 * Account page; any one for an admin on Settings → AI assistants.
 */
export const DELETE: RequestHandler = route.user(({ params }, { user }) => {
	const result = disconnectGrant(
		database,
		{ userId: user.id, admin: user.role === 'admin' },
		params.id,
		Date.now()
	);
	switch (result.kind) {
		case 'ended':
			// Its requests waiting for approval are cancelled (SPEC-MCP M21).
			settleEndedGrantRuns({ database, runner: appRunner(), now: Date.now() });
			return Response.json({ disconnected: true });
		case 'refused':
			return Response.json({ message: result.message }, { status: result.status });
	}
});
