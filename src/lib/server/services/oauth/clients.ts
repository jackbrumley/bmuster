import { randomBytes } from 'node:crypto';
import { and, eq, isNull, lt, notExists } from 'drizzle-orm';
import { z } from 'zod';
import type { AssistantName } from '#lib/domain/mcp/mcp.ts';
import {
	clientMetadataDocumentSchema,
	type ClientMetadataDocument,
	registrationRequestSchema
} from '#lib/schemas/mcp/oauth.ts';
import { oauthClients, oauthGrants } from '../../database/schema.ts';
import type { Queryable } from '../../database/connection.ts';
import { CLIENT_AUTH_METHODS, isClientAuthMethod, type ClientAuthMethod } from './client-auth.ts';
import { oauthLog, type OAuthLogFacts } from './oauth-log.ts';
import { fetchableUrl, type FetchJson } from './safe-fetch.ts';
import { hashSecret, newSecret } from './secrets.ts';

/**
 * OAuth clients (SPEC-MCP M6). A `client_id` that is an HTTPS URL is a Client ID Metadata
 * Document: fetched safely, cached up to 24 hours, and it must name itself. Anything else must
 * have been registered through `/oauth/register` (DCR, public or with a client secret, M33),
 * which grants nothing and marks the client unverified. Redirect URIs match exactly, except loopback ones, which match on any port.
 */

const DOCUMENT_CACHE_MS = 24 * 60 * 60_000;

/** Registered clients nobody connected within a day are pruned at the next registration. */
const UNUSED_REGISTRATION_MS = 24 * 60 * 60_000;

export type ClientRecord = {
	id: string;
	clientId: string;
	assistant: AssistantName;
	redirectUris: string[];
};

type ClientRow = typeof oauthClients.$inferSelect;

const storedUris = z.array(z.string());

function toRecord(row: ClientRow): ClientRecord {
	return {
		id: row.id,
		clientId: row.clientId,
		assistant: assistantOf(row),
		redirectUris: storedUris.parse(JSON.parse(row.redirectUris))
	};
}

/** A metadata document's client is named for the host that serves it; a registered one is not. */
export function assistantOf(row: Pick<ClientRow, 'kind' | 'name' | 'clientId'>): AssistantName {
	switch (row.kind) {
		case 'metadata-document':
			return { name: row.name, identity: { kind: 'verified', host: new URL(row.clientId).host } };
		case 'registered':
			return { name: row.name, identity: { kind: 'unverified' } };
	}
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

function parsed(raw: string): URL | undefined {
	try {
		return new URL(raw);
	} catch {
		return undefined;
	}
}

/** True for `http://localhost…`, `http://127.0.0.1…` and `http://[::1]…`. */
export function isLoopbackRedirect(raw: string): boolean {
	const url = parsed(raw);
	return url?.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
}

/** A redirect URI a client may declare: HTTPS, or HTTP on loopback; no fragment, no credentials. */
function isAcceptableRedirect(raw: string): boolean {
	const url = parsed(raw);
	if (url?.hash !== '' || raw.includes('#')) {
		return false;
	}
	if (url.username !== '' || url.password !== '') {
		return false;
	}
	return url.protocol === 'https:' || isLoopbackRedirect(raw);
}

/**
 * Exact match, except a loopback redirect, which matches the declared one on any port (native
 * clients such as Claude Code pick a free port each time). Scheme, host, path and query must
 * still be the same.
 */
export function redirectUriMatches(declared: string, requested: string): boolean {
	if (declared === requested) {
		return true;
	}
	if (!isLoopbackRedirect(declared) || !isLoopbackRedirect(requested)) {
		return false;
	}
	const a = parsed(declared);
	const b = parsed(requested);
	if (a === undefined || b?.hash !== '') {
		return false;
	}
	return (
		a.protocol === b.protocol &&
		a.hostname === b.hostname &&
		a.pathname === b.pathname &&
		a.search === b.search
	);
}

/** True when the client declared a redirect URI that `requested` matches. */
export function allowsRedirect(client: ClientRecord, requested: string): boolean {
	return client.redirectUris.some((declared) => redirectUriMatches(declared, requested));
}

/** The URL is shaped like a metadata document's address (an HTTPS URL with a path). */
export function isMetadataDocumentUrl(clientId: string): boolean {
	const url = fetchableUrl(clientId);
	return (
		url?.hash === '' &&
		!clientId.includes('#') &&
		url.pathname !== '/' &&
		!url.pathname.split('/').some((segment) => segment === '.' || segment === '..')
	);
}

export type ClientLookup =
	{ kind: 'found'; client: ClientRecord } | { kind: 'unknown'; message: string; why: string };

const BAD_REDIRECTS = 'Every redirect URI must be https://, or http:// on localhost or 127.0.0.1.';

function unknown(message: string, why: string): ClientLookup {
	return { kind: 'unknown', message, why };
}

/**
 * A metadata document's client is public: it must be able to use `none` (M6, M34), either as
 * its one method or among the methods it lists. BMuster offers no `private_key_jwt`, so a client
 * that lists both picks `none` and proves itself with PKCE.
 */
function documentProblem(document: ClientMetadataDocument): string | undefined {
	const preferred = document.token_endpoint_auth_method;
	const listed = document.token_endpoint_auth_methods_supported ?? [];
	if (preferred !== undefined && preferred !== 'none' && !listed.includes('none')) {
		return 'Only public clients may connect with a metadata document (token_endpoint_auth_method "none").';
	}
	if (!document.redirect_uris.every(isAcceptableRedirect)) {
		return BAD_REDIRECTS;
	}
	return undefined;
}

/**
 * The client behind a `client_id`: a metadata document (fetched again when the cached copy is a
 * day old) or a registered client. Fails closed: a document that cannot be fetched now is refused.
 * `message` is for the consent page; `why` is the fuller reason for the server log (M31).
 */
export async function resolveClient(
	database: Queryable,
	clientId: string,
	fetchJson: FetchJson,
	now: number
): Promise<ClientLookup> {
	const row = database.select().from(oauthClients).where(eq(oauthClients.clientId, clientId)).get();
	if (!isMetadataDocumentUrl(clientId)) {
		return row?.kind === 'registered'
			? { kind: 'found', client: toRecord(row) }
			: unknown(
					'This assistant is not registered with BMuster.',
					'the client_id is not registered (unused registrations are pruned after a day) and is not a metadata document URL'
				);
	}
	if (row?.fetchedAt !== undefined && row.fetchedAt !== null) {
		if (now - row.fetchedAt.getTime() < DOCUMENT_CACHE_MS) {
			return { kind: 'found', client: toRecord(row) };
		}
	}
	const fetched = await fetchJson(clientId);
	if (fetched.kind === 'failed') {
		return unknown(
			`BMuster could not read the assistant's metadata document: ${fetched.reason}`,
			`the metadata document could not be fetched: ${fetched.reason}`
		);
	}
	const document = clientMetadataDocumentSchema.safeParse(fetched.json);
	if (!document.success) {
		const fields = document.error.issues.map((issue) => issue.path.join('.')).join(', ');
		return unknown(
			"The assistant's metadata document is not valid.",
			`the metadata document is not valid (fields: ${fields})`
		);
	}
	if (document.data.client_id !== clientId) {
		return unknown(
			"The assistant's metadata document names a different client_id.",
			`the metadata document names client_id ${document.data.client_id}`
		);
	}
	const problem = documentProblem(document.data);
	if (problem !== undefined) {
		const methods = [
			document.data.token_endpoint_auth_method ?? '(none given)',
			...(document.data.token_endpoint_auth_methods_supported ?? [])
		].join(', ');
		return unknown(
			problem,
			`the metadata document was refused: ${problem} Its auth methods: ${methods}. Its redirect URIs: ${document.data.redirect_uris.join(' ')}`
		);
	}
	const host = new URL(clientId).host;
	const values = {
		kind: 'metadata-document' as const,
		clientId,
		name: document.data.client_name ?? host,
		clientUri: document.data.client_uri ?? '',
		redirectUris: JSON.stringify(document.data.redirect_uris),
		metadata: JSON.stringify(document.data),
		tokenEndpointAuthMethod: 'none' as const,
		secretHash: null,
		fetchedAt: new Date(now)
	};
	database
		.insert(oauthClients)
		.values({ id: crypto.randomUUID(), createdAt: new Date(now), ...values })
		.onConflictDoUpdate({ target: oauthClients.clientId, set: values })
		.run();
	const stored = database
		.select()
		.from(oauthClients)
		.where(eq(oauthClients.clientId, clientId))
		.get();
	if (stored === undefined) {
		throw new Error('The client just stored is missing');
	}
	return { kind: 'found', client: toRecord(stored) };
}

export type Registration =
	| {
			kind: 'registered';
			reply: {
				client_id: string;
				client_id_issued_at: number;
				/** Only for a confidential client: shown this once, then kept only as its hash. */
				client_secret: string | undefined;
				/** 0 (never expires, RFC 7591 3.2.1), beside a secret only. */
				client_secret_expires_at: number | undefined;
				client_name: string;
				redirect_uris: string[];
				token_endpoint_auth_method: ClientAuthMethod;
				grant_types: string[];
				response_types: string[];
			};
			name: string;
	  }
	| { kind: 'refused'; error: 'invalid_client_metadata' | 'invalid_redirect_uri'; message: string };

function refusedRegistration(
	error: 'invalid_client_metadata' | 'invalid_redirect_uri',
	message: string,
	facts: OAuthLogFacts,
	now: number
): Registration {
	oauthLog('info', 'register', `refused (${error}): ${message}`, facts, now);
	return { kind: 'refused', error, message };
}

/** The registration's name, redirect URIs and method for the log, whatever shape it came in. */
const looseRegistration = z
	.object({
		client_name: z.string().optional().catch(undefined),
		redirect_uris: z.array(z.string()).optional().catch(undefined),
		token_endpoint_auth_method: z.string().optional().catch(undefined)
	})
	.catch({
		client_name: undefined,
		redirect_uris: undefined,
		token_endpoint_auth_method: undefined
	});

function registrationFacts(body: unknown): OAuthLogFacts {
	const facts = looseRegistration.parse(body);
	return {
		client: facts.client_name ?? null,
		redirectUri: facts.redirect_uris?.join(' ') ?? null,
		authMethod: facts.token_endpoint_auth_method ?? null
	};
}

/**
 * Dynamic Client Registration (RFC 7591): unverified, and may do nothing until a person allows
 * it. Public (`none`, also when no method is named) or confidential (`client_secret_post` or
 * `client_secret_basic`, M33), which gets a secret once, kept only as SHA-256.
 */
export function registerClient(database: Queryable, body: unknown, now: number): Registration {
	const facts = registrationFacts(body);
	const request = registrationRequestSchema.safeParse(body);
	if (!request.success) {
		return refusedRegistration(
			'invalid_client_metadata',
			'The registration needs redirect_uris and may hold only the usual fields.',
			facts,
			now
		);
	}
	const method = request.data.token_endpoint_auth_method ?? 'none';
	if (!isClientAuthMethod(method)) {
		return refusedRegistration(
			'invalid_client_metadata',
			`token_endpoint_auth_method must be one of ${CLIENT_AUTH_METHODS.join(', ')}.`,
			facts,
			now
		);
	}
	if (!request.data.redirect_uris.every(isAcceptableRedirect)) {
		return refusedRegistration('invalid_redirect_uri', BAD_REDIRECTS, facts, now);
	}
	pruneUnusedRegistrations(database, now);
	const clientId = `bmc_${randomBytes(18).toString('base64url')}`;
	const secret = method === 'none' ? undefined : newSecret('bmcs_');
	const name = request.data.client_name ?? 'Unnamed client';
	database
		.insert(oauthClients)
		.values({
			id: crypto.randomUUID(),
			kind: 'registered',
			clientId,
			name,
			clientUri: request.data.client_uri ?? '',
			redirectUris: JSON.stringify(request.data.redirect_uris),
			metadata: JSON.stringify(request.data),
			tokenEndpointAuthMethod: method,
			secretHash: secret === undefined ? null : hashSecret(secret),
			fetchedAt: null,
			createdAt: new Date(now)
		})
		.run();
	oauthLog(
		'info',
		'register',
		'registered a client (unverified)',
		{ ...facts, client: `${name} (${clientId})`, authMethod: method },
		now
	);
	return {
		kind: 'registered',
		name,
		reply: {
			client_id: clientId,
			client_id_issued_at: Math.floor(now / 1000),
			client_secret: secret,
			client_secret_expires_at: secret === undefined ? undefined : 0,
			client_name: name,
			redirect_uris: request.data.redirect_uris,
			token_endpoint_auth_method: method,
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code']
		}
	};
}

/** Claude registers anew on every fresh connection, so registrations nobody used are dropped. */
function pruneUnusedRegistrations(database: Queryable, now: number): void {
	database
		.delete(oauthClients)
		.where(
			and(
				eq(oauthClients.kind, 'registered'),
				lt(oauthClients.createdAt, new Date(now - UNUSED_REGISTRATION_MS)),
				notExists(
					database
						.select({ id: oauthGrants.id })
						.from(oauthGrants)
						.where(eq(oauthGrants.oauthClientId, oauthClients.id))
				),
				isNull(oauthClients.fetchedAt)
			)
		)
		.run();
}
