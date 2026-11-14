import { revokeRequestSchema } from '#lib/schemas/mcp/oauth.ts';
import { database } from '#lib/server/database/app-database.ts';
import { route } from '#lib/server/guards/route.ts';
import { presentedClient, usedBasic } from '#lib/server/services/oauth/client-auth.ts';
import { NO_FACTS, oauthLog } from '#lib/server/services/oauth/oauth-log.ts';
import { revokeToken } from '#lib/server/services/oauth/tokens.ts';
import { invalidClient, malformedClient, oauthError, readForm } from '../oauth-replies.server.ts';
import type { RequestHandler } from './$types';

/**
 * POST /oauth/revoke (RFC 7009, SPEC-MCP M8, M33): 200 whether or not the token was known; 401
 * when a confidential client's secret is missing or wrong.
 */
export const POST: RequestHandler = route.oauth(async ({ request }) => {
	const now = Date.now();
	const form = await readForm(request);
	const client = presentedClient(request.headers.get('authorization'), form ?? {});
	if (client.kind === 'malformed') {
		return malformedClient('revoke', client, now);
	}
	const parsed = revokeRequestSchema.safeParse(
		form === undefined ? undefined : { ...form, client_id: client.clientId }
	);
	if (!parsed.success) {
		const description = 'Send the token, form-encoded.';
		oauthLog('info', 'revoke', `refused (invalid_request): ${description}`, NO_FACTS, now);
		return oauthError('invalid_request', description, 400);
	}
	const outcome = revokeToken(
		database,
		{ token: parsed.data.token, clientId: parsed.data.client_id, secret: client.secret },
		now
	);
	switch (outcome.kind) {
		case 'refused':
			return invalidClient('Client authentication failed.', usedBasic(client.secret));
		case 'answered':
			return new Response(null, { status: 200, headers: { 'cache-control': 'no-store' } });
	}
});
