import { timingSafeEqual } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { oauthClients } from '../../database/schema.ts';
import type { Queryable } from '../../database/connection.ts';
import { hashSecret } from './secrets.ts';

/**
 * Client authentication at the token and revoke endpoints (SPEC-MCP M33, RFC 6749 2.3). Public
 * clients (`none`: CIMD, and DCR clients that asked for no secret) send only their `client_id`
 * and prove themselves with PKCE. A registered confidential client must also send its secret,
 * in the form (`client_secret_post`) or as HTTP Basic (`client_secret_basic`); either way is
 * accepted, since the secret is the proof, and it is compared in constant time against its hash.
 */

export const CLIENT_AUTH_METHODS = ['none', 'client_secret_post', 'client_secret_basic'] as const;

export type ClientAuthMethod = (typeof CLIENT_AUTH_METHODS)[number];

export function isClientAuthMethod(value: string): value is ClientAuthMethod {
	return CLIENT_AUTH_METHODS.some((method) => method === value);
}

/** The secret a request carried. An empty one counts as none (RFC 6749 2.3.1 allows `id:`). */
export type PresentedSecret =
	| { kind: 'none' }
	| { kind: 'secret'; via: 'client_secret_post' | 'client_secret_basic'; value: string };

export type PresentedClient =
	| { kind: 'presented'; clientId: string | undefined; secret: PresentedSecret }
	| { kind: 'malformed'; reason: string; basic: boolean };

/** `application/x-www-form-urlencoded` decoding, as RFC 6749 2.3.1 asks for Basic's parts. */
function formDecoded(part: string): string | undefined {
	try {
		return decodeURIComponent(part.replaceAll('+', ' '));
	} catch {
		return undefined;
	}
}

function basicCredentials(
	header: string
): { kind: 'read'; clientId: string; secret: string } | { kind: 'malformed' } {
	const encoded = /^Basic ([A-Za-z0-9+/]+=*)$/i.exec(header.trim())?.[1];
	if (encoded === undefined) {
		return { kind: 'malformed' };
	}
	const decoded = Buffer.from(encoded, 'base64').toString('utf8');
	const colon = decoded.indexOf(':');
	if (colon < 1) {
		return { kind: 'malformed' };
	}
	const clientId = formDecoded(decoded.slice(0, colon));
	const secret = formDecoded(decoded.slice(colon + 1));
	return clientId === undefined || secret === undefined || clientId === ''
		? { kind: 'malformed' }
		: { kind: 'read', clientId, secret };
}

/**
 * Who the request says it is, from the Authorization header and the form. Only one method per
 * request (RFC 6749 2.3): Basic plus a form secret, or a Basic id that differs from the form's,
 * is malformed. Any other Authorization scheme is not client authentication and is ignored.
 */
export function presentedClient(
	authorization: string | null,
	form: Record<string, string>
): PresentedClient {
	const formId = form['client_id'];
	const formSecret = form['client_secret'] ?? '';
	if (authorization !== null && /^basic\b/i.test(authorization.trim())) {
		const basic = basicCredentials(authorization);
		if (basic.kind === 'malformed') {
			return { kind: 'malformed', reason: 'The Basic credentials are not valid.', basic: true };
		}
		if (formSecret !== '') {
			return {
				kind: 'malformed',
				reason: 'Send the client secret one way only: Basic or the form.',
				basic: true
			};
		}
		if (formId !== undefined && formId !== basic.clientId) {
			return {
				kind: 'malformed',
				reason: 'The client_id in the form differs from the Basic one.',
				basic: true
			};
		}
		return {
			kind: 'presented',
			clientId: basic.clientId,
			secret:
				basic.secret === ''
					? { kind: 'none' }
					: { kind: 'secret', via: 'client_secret_basic', value: basic.secret }
		};
	}
	return {
		kind: 'presented',
		clientId: formId,
		secret:
			formSecret === ''
				? { kind: 'none' }
				: { kind: 'secret', via: 'client_secret_post', value: formSecret }
	};
}

/** Whether the client tried HTTP Basic: a refusal then carries a Basic challenge (RFC 6749 5.2). */
export function usedBasic(secret: PresentedSecret): boolean {
	return secret.kind === 'secret' && secret.via === 'client_secret_basic';
}

/** The auth method a request used, for the log. */
export function presentedMethod(secret: PresentedSecret): ClientAuthMethod {
	return secret.kind === 'none' ? 'none' : secret.via;
}

export type ClientCheck = { kind: 'accepted' } | { kind: 'refused'; why: string };

function sameHash(a: string, b: string): boolean {
	const left = Buffer.from(a, 'utf8');
	const right = Buffer.from(b, 'utf8');
	return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Checks the secret against the client it names. An unknown client with no secret is passed on,
 * so the grant checks refuse it as they always have (`invalid_grant`); with a secret it is
 * refused here. A public client that sends a secret is refused: it was never given one.
 */
export function checkClientSecret(
	database: Queryable,
	clientId: string,
	secret: PresentedSecret
): ClientCheck {
	const row = database
		.select({
			method: oauthClients.tokenEndpointAuthMethod,
			secretHash: oauthClients.secretHash
		})
		.from(oauthClients)
		.where(eq(oauthClients.clientId, clientId))
		.get();
	if (row === undefined) {
		return secret.kind === 'none'
			? { kind: 'accepted' }
			: { kind: 'refused', why: 'an unknown client sent a client secret' };
	}
	if (row.method === 'none' || row.secretHash === null) {
		return secret.kind === 'none'
			? { kind: 'accepted' }
			: { kind: 'refused', why: 'a public client sent a client secret it was never given' };
	}
	if (secret.kind === 'none') {
		return { kind: 'refused', why: `the client registered ${row.method} but sent no secret` };
	}
	return sameHash(hashSecret(secret.value), row.secretHash)
		? { kind: 'accepted' }
		: { kind: 'refused', why: 'the client secret is wrong' };
}
