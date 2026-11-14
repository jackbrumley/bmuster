import { mcpServerUrl } from '#lib/domain/mcp/mcp.ts';
import { tokenRequestSchema } from '#lib/schemas/mcp/oauth.ts';
import { database } from '#lib/server/database/app-database.ts';
import { route } from '#lib/server/guards/route.ts';
import { presentedClient, usedBasic } from '#lib/server/services/oauth/client-auth.ts';
import { NO_FACTS, oauthLog } from '#lib/server/services/oauth/oauth-log.ts';
import { tokenRequest } from '#lib/server/services/oauth/tokens.ts';
import {
	invalidClient,
	malformedClient,
	oauthError,
	oauthJson,
	readForm
} from '../oauth-replies.server.ts';
import type { RequestHandler } from './$types';

/**
 * POST /oauth/token (SPEC-MCP M8, M9, M33): form-encoded `authorization_code` and
 * `refresh_token`. The client names itself in the form or with HTTP Basic; the service checks a
 * confidential client's secret.
 */
export const POST: RequestHandler = route.oauth(async ({ request }, { origin }) => {
	const now = Date.now();
	const refuse = (error: string, description: string): Response => {
		oauthLog('info', 'token', `refused (${error}): ${description}`, NO_FACTS, now);
		return oauthError(error, description, 400);
	};
	const form = await readForm(request);
	if (form === undefined) {
		return refuse('invalid_request', 'Send the request form-encoded.');
	}
	if (form['grant_type'] !== 'authorization_code' && form['grant_type'] !== 'refresh_token') {
		return refuse('unsupported_grant_type', 'Only authorization_code and refresh_token.');
	}
	const client = presentedClient(request.headers.get('authorization'), form);
	if (client.kind === 'malformed') {
		return malformedClient('token', client, now);
	}
	const parsed = tokenRequestSchema.safeParse({ ...form, client_id: client.clientId });
	if (!parsed.success) {
		const fields = parsed.error.issues.map((issue) => issue.path.join('.')).join(', ');
		return refuse('invalid_request', `A required field is missing or too long: ${fields}.`);
	}
	const reply = tokenRequest(database, parsed.data, client.secret, mcpServerUrl(origin), now);
	switch (reply.kind) {
		case 'issued':
			return oauthJson(reply.body, 200);
		case 'error':
			return reply.error === 'invalid_client'
				? invalidClient(reply.description, usedBasic(client.secret))
				: oauthError(reply.error, reply.description, reply.status);
	}
});
