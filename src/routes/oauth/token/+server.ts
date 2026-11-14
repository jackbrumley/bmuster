import { mcpServerUrl } from '#lib/domain/mcp/mcp.ts';
import { tokenRequestSchema } from '#lib/schemas/mcp/oauth.ts';
import { database } from '#lib/server/database/app-database.ts';
import { route } from '#lib/server/guards/route.ts';
import { tokenRequest } from '#lib/server/services/oauth/tokens.ts';
import { oauthError, oauthJson, readForm } from '../oauth-replies.server.ts';
import type { RequestHandler } from './$types';

/** POST /oauth/token (SPEC-MCP M8, M9): form-encoded `authorization_code` and `refresh_token`. */
export const POST: RequestHandler = route.oauth(async ({ request }, { origin }) => {
	const form = await readForm(request);
	if (form === undefined) {
		return oauthError('invalid_request', 'Send the request form-encoded.', 400);
	}
	if (form['grant_type'] !== 'authorization_code' && form['grant_type'] !== 'refresh_token') {
		return oauthError('unsupported_grant_type', 'Only authorization_code and refresh_token.', 400);
	}
	const parsed = tokenRequestSchema.safeParse(form);
	if (!parsed.success) {
		return oauthError('invalid_request', 'A required field is missing.', 400);
	}
	const reply = tokenRequest(database, parsed.data, mcpServerUrl(origin), Date.now());
	switch (reply.kind) {
		case 'issued':
			return oauthJson(reply.body, 200);
		case 'error':
			return oauthError(reply.error, reply.description, reply.status);
	}
});
