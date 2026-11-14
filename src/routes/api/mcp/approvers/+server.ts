import { approverSettingsRequestSchema } from '#lib/schemas/mcp/console.ts';
import { database } from '#lib/server/database/app-database.ts';
import { route } from '#lib/server/guards/route.ts';
import { writeApproverSettings } from '#lib/server/services/oauth/mcp-settings.ts';
import { invalidRequest, readJson } from '../../replies.server.ts';
import type { RequestHandler } from './$types';

/** PUT /api/mcp/approvers: who may approve an AI assistant's command (admins; SPEC-MCP M19). */
export const PUT: RequestHandler = route.admin(async ({ request }, { user }) => {
	const parsed = approverSettingsRequestSchema.safeParse(await readJson(request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	const change = writeApproverSettings(database, user.id, parsed.data, Date.now());
	switch (change.kind) {
		case 'changed':
			return Response.json({ saved: true });
		case 'refused':
			return Response.json({ message: change.message }, { status: 400 });
	}
});
