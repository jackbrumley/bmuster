import { mcpSettingsRequestSchema } from '#lib/schemas/mcp/console.ts';
import { database } from '#lib/server/database/app-database.ts';
import { route } from '#lib/server/guards/route.ts';
import { saveMcpSettings } from '#lib/server/services/oauth/grants.ts';
import { invalidRequest, readJson } from '../../replies.server.ts';
import type { RequestHandler } from './$types';

/**
 * PUT /api/mcp/settings: Allow AI assistants (MCP) and who may connect one (admins; SPEC-MCP M1).
 * Turning it off, or changing the group, ends the grants it no longer allows.
 */
export const PUT: RequestHandler = route.admin(async ({ request }, { user }) => {
	const parsed = mcpSettingsRequestSchema.safeParse(await readJson(request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	const change = saveMcpSettings(database, user.id, parsed.data, Date.now());
	switch (change.kind) {
		case 'changed':
			return Response.json(change.settings);
		case 'refused':
			return Response.json({ message: change.message }, { status: 400 });
	}
});
