import type { PresentedClient } from '#lib/server/services/oauth/client-auth.ts';
import { NO_FACTS, oauthLog, type OAuthEndpoint } from '#lib/server/services/oauth/oauth-log.ts';

/**
 * OAuth replies (RFC 6749 5.1, 5.2): JSON that is never cached, and errors as
 * `{ error, error_description }`.
 */
const NO_STORE = { 'cache-control': 'no-store', pragma: 'no-cache' } as const;

export function oauthJson(body: unknown, status: number): Response {
	return Response.json(body, { status, headers: NO_STORE });
}

export function oauthError(error: string, description: string, status: 400 | 401 | 429): Response {
	return oauthJson({ error, error_description: description }, status);
}

/**
 * Client authentication failed (RFC 6749 5.2): 401 `invalid_client`, with a Basic challenge when
 * the client tried HTTP Basic.
 */
export function invalidClient(description: string, basic: boolean): Response {
	return Response.json(
		{ error: 'invalid_client', error_description: description },
		{
			status: 401,
			headers: basic ? { ...NO_STORE, 'www-authenticate': 'Basic realm="BMuster"' } : NO_STORE
		}
	);
}

/** Credentials that could not be read (bad Basic, or two methods at once): logged and refused. */
export function malformedClient(
	endpoint: OAuthEndpoint,
	client: Extract<PresentedClient, { kind: 'malformed' }>,
	now: number
): Response {
	oauthLog('info', endpoint, `refused (invalid_client): ${client.reason}`, NO_FACTS, now);
	return invalidClient(client.reason, client.basic);
}

/** A form-encoded body as plain fields; repeated names keep the first. */
export async function readForm(request: Request): Promise<Record<string, string> | undefined> {
	const type = request.headers.get('content-type') ?? '';
	if (!type.toLowerCase().startsWith('application/x-www-form-urlencoded')) {
		return undefined;
	}
	const fields: Record<string, string> = {};
	for (const [name, value] of new URLSearchParams(await request.text())) {
		if (!(name in fields)) fields[name] = value;
	}
	return fields;
}
