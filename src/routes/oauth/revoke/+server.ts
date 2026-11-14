import { revokeRequestSchema } from '#lib/schemas/mcp/oauth.ts';
import { database } from '#lib/server/database/app-database.ts';
import { route } from '#lib/server/guards/route.ts';
import { revokeToken } from '#lib/server/services/oauth/tokens.ts';
import { oauthError, readForm } from '../oauth-replies.server.ts';
import type { RequestHandler } from './$types';

/** POST /oauth/revoke (RFC 7009, SPEC-MCP M8): 200 whether or not the token was known. */
export const POST: RequestHandler = route.oauth(async ({ request }) => {
	const form = await readForm(request);
	const parsed = revokeRequestSchema.safeParse(form);
	if (!parsed.success) {
		return oauthError('invalid_request', 'Send the token, form-encoded.', 400);
	}
	revokeToken(database, { token: parsed.data.token, clientId: parsed.data.client_id }, Date.now());
	return new Response(null, { status: 200, headers: { 'cache-control': 'no-store' } });
});
