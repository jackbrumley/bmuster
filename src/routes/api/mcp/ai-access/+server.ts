import { aiAccessRequestSchema } from '#lib/schemas/mcp/console.ts';
import { database } from '#lib/server/database/app-database.ts';
import { route } from '#lib/server/guards/route.ts';
import { grantAiAccess } from '#lib/server/services/oauth/ai-access.ts';
import { invalidRequest, readJson } from '../../replies.server.ts';
import type { RequestHandler } from './$types';

/**
 * POST /api/mcp/ai-access: gives the group who may connect an assistant AI can view, or AI
 * commands, on All machines (admins; SPEC-SAVED-COMMANDS SC25), through the access rules service.
 */
export const POST: RequestHandler = route.admin(async ({ request }, { user }) => {
	const parsed = aiAccessRequestSchema.safeParse(await readJson(request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	const change = grantAiAccess(database, user.id, parsed.data.level, Date.now());
	switch (change.kind) {
		case 'done':
			return Response.json({ granted: true });
		case 'refused':
			return Response.json({ message: change.message }, { status: change.status });
	}
});
