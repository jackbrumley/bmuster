import { database } from '#lib/server/database/app-database.ts';
import { route } from '#lib/server/guards/route.ts';
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
			return Response.json({ disconnected: true });
		case 'refused':
			return Response.json({ message: result.message }, { status: result.status });
	}
});
