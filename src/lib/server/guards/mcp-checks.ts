import type { RequestEvent } from '@sveltejs/kit';
import { database } from '../database/app-database.ts';
import { bearerChallenge } from '../services/oauth/metadata.ts';
import { mcpEnabled } from '../services/oauth/mcp-settings.ts';
import { authenticateAccessToken, type McpPrincipal } from '../services/oauth/tokens.ts';

/**
 * The checks behind `route.oauth` and `route.mcp` (SPEC-MCP M1, M4). While MCP is off every one
 * of these paths answers 404, as if it did not exist. `/mcp` takes only a bearer token (the
 * console cookie is never read there) and refuses a browser page from another site.
 */

/** This server as assistants reach it: the issuer, and `<origin>/mcp` as the resource. */
export type OAuthContext = { origin: string };

export type McpContext = { origin: string; principal: McpPrincipal };

const NOT_FOUND = (): Response => Response.json({ message: 'Not found.' }, { status: 404 });

export function oauthRefusal(event: RequestEvent): Response | OAuthContext {
	return mcpEnabled(database) ? { origin: event.url.origin } : NOT_FOUND();
}

const BEARER = /^Bearer ([A-Za-z0-9_\-.~+/]+=*)$/;

export function mcpRefusal(event: RequestEvent): Response | McpContext {
	if (!mcpEnabled(database)) {
		return NOT_FOUND();
	}
	const origin = event.url.origin;
	// DNS rebinding and browser pages: a request that says where it came from must be from here.
	const claimed = event.request.headers.get('origin');
	if (claimed !== null && claimed !== origin) {
		return Response.json({ message: 'This request came from another site.' }, { status: 403 });
	}
	const authorization = event.request.headers.get('authorization');
	const token = authorization === null ? undefined : BEARER.exec(authorization)?.[1];
	if (token === undefined) {
		return Response.json(
			{ error: 'unauthorized', error_description: 'Sign in through your assistant first.' },
			{ status: 401, headers: { 'www-authenticate': bearerChallenge(origin, 'none') } }
		);
	}
	const check = authenticateAccessToken(
		database,
		token,
		{
			ip: event.getClientAddress(),
			userAgent: event.request.headers.get('user-agent') ?? ''
		},
		Date.now()
	);
	switch (check.kind) {
		case 'invalid':
			return Response.json(
				{
					error: 'invalid_token',
					error_description: 'The token is not valid, has expired or was revoked.'
				},
				{ status: 401, headers: { 'www-authenticate': bearerChallenge(origin, 'invalid_token') } }
			);
		case 'valid':
			return { origin, principal: check.principal };
	}
}
