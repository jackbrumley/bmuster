import { eq } from 'drizzle-orm';
import type { Queryable } from '../../database/connection.ts';
import { oauthClients } from '../../database/schema.ts';
import { serverLog, type ServerLogLevel } from '../logs/server-log.ts';

/**
 * One server log line per OAuth or MCP step that fails, and per registration and token grant
 * (SPEC-MCP M31), so `npm run diagnostics -- server` shows a whole connection attempt. Lines name
 * the endpoint, the reason, the client, the redirect URI and the auth method, and nothing else:
 * never a token, code, client secret, PKCE verifier or `state`. Callers pass only these facts.
 */

export type OAuthEndpoint = 'register' | 'authorize' | 'token' | 'revoke' | 'mcp' | 'discovery';

export type OAuthLogFacts = {
	/** The client's name and id (`describeClient`), or the id as sent; null when none was sent. */
	client: string | null;
	redirectUri: string | null;
	/** The auth method asked for or used (`none`, `client_secret_post`, …); null when not known. */
	authMethod: string | null;
};

export const NO_FACTS: OAuthLogFacts = { client: null, redirectUri: null, authMethod: null };

/** Values come from untrusted requests: quoted, control characters escaped, and cut short. */
function quoted(value: string): string {
	return JSON.stringify(value.length > 300 ? `${value.slice(0, 300)}…` : value);
}

export function oauthLog(
	level: ServerLogLevel,
	endpoint: OAuthEndpoint,
	message: string,
	facts: OAuthLogFacts,
	now: number
): void {
	const parts = [`OAuth ${endpoint}: ${message}`];
	if (facts.client !== null) parts.push(`client=${quoted(facts.client)}`);
	if (facts.redirectUri !== null) parts.push(`redirect_uri=${quoted(facts.redirectUri)}`);
	if (facts.authMethod !== null) parts.push(`auth_method=${quoted(facts.authMethod)}`);
	serverLog(level, 'oauth', parts.join(' '), null, now);
}

/** `"ChatGPT" (https://chatgpt.com/oauth/client.json)` for a known client, else the id as sent. */
export function describeClient(database: Queryable, clientId: string): string {
	const row = database
		.select({ name: oauthClients.name })
		.from(oauthClients)
		.where(eq(oauthClients.clientId, clientId))
		.get();
	return row === undefined ? `unknown ${clientId}` : `${row.name} (${clientId})`;
}
