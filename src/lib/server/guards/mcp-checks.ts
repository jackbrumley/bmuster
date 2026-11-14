import type { RequestEvent } from '@sveltejs/kit';
import { database } from '../database/app-database.ts';
import { bearerChallenge } from '../services/oauth/metadata.ts';
import { mcpEnabled } from '../services/oauth/mcp-settings.ts';
import { NO_FACTS, oauthLog, type OAuthEndpoint } from '../services/oauth/oauth-log.ts';
import { authenticateAccessToken, type McpPrincipal } from '../services/oauth/tokens.ts';

/**
 * The checks behind `route.oauth` and `route.mcp` (SPEC-MCP M1, M4). While MCP is off every one
 * of these paths answers 404, as if it did not exist. `/mcp` takes only a bearer token (the
 * console cookie is never read there) and refuses a browser page from another site. Every
 * refusal writes one server log line (M31).
 */

/** This server as assistants reach it: the issuer, and `<origin>/mcp` as the resource. */
export type OAuthContext = { origin: string };

export type McpContext = { origin: string; principal: McpPrincipal };

const NOT_FOUND = (): Response => Response.json({ message: 'Not found.' }, { status: 404 });

/** Which endpoint a path under the OAuth guard is, for the log. */
function endpointOf(pathname: string): OAuthEndpoint {
	if (pathname.startsWith('/oauth/register')) return 'register';
	if (pathname.startsWith('/oauth/token')) return 'token';
	if (pathname.startsWith('/oauth/revoke')) return 'revoke';
	if (pathname.startsWith('/oauth/authorize')) return 'authorize';
	if (pathname.startsWith('/mcp')) return 'mcp';
	return 'discovery';
}

/** Logs the 404 these paths answer while AI assistants are off, so a failed connection is explained. */
export function logMcpOff(event: RequestEvent): void {
	oauthLog(
		'info',
		endpointOf(event.url.pathname),
		`answered 404 for ${event.request.method} ${event.url.pathname}: AI assistants (MCP) are off in Settings`,
		NO_FACTS,
		Date.now()
	);
}

export function oauthRefusal(event: RequestEvent): Response | OAuthContext {
	if (!mcpEnabled(database)) {
		logMcpOff(event);
		return NOT_FOUND();
	}
	return { origin: event.url.origin };
}

const BEARER = /^Bearer ([A-Za-z0-9_\-.~+/]+=*)$/;

export function mcpRefusal(event: RequestEvent): Response | McpContext {
	if (!mcpEnabled(database)) {
		logMcpOff(event);
		return NOT_FOUND();
	}
	const origin = event.url.origin;
	const now = Date.now();
	// DNS rebinding and browser pages: a request that says where it came from must be from here.
	const claimed = event.request.headers.get('origin');
	if (claimed !== null && claimed !== origin) {
		const why = `refused (403): the Origin header ${JSON.stringify(claimed)} is not ${origin}`;
		oauthLog('warn', 'mcp', why, NO_FACTS, now);
		return Response.json({ message: 'This request came from another site.' }, { status: 403 });
	}
	const authorization = event.request.headers.get('authorization');
	const token = authorization === null ? undefined : BEARER.exec(authorization)?.[1];
	if (token === undefined) {
		const sent =
			authorization === null
				? 'no Authorization header'
				: 'an Authorization header that is not a bearer token';
		oauthLog('info', 'mcp', `answered 401 with the sign-in challenge: ${sent}`, NO_FACTS, now);
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
		now
	);
	switch (check.kind) {
		case 'invalid':
			oauthLog(
				'info',
				'mcp',
				`answered 401 invalid_token: ${check.why}`,
				{ ...NO_FACTS, client: check.client },
				now
			);
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
