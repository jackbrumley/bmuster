import { randomBytes } from 'node:crypto';
import { and, eq, isNull, lt, notExists } from 'drizzle-orm';
import { z } from 'zod';
import type { AssistantName } from '#lib/domain/mcp/mcp.ts';
import {
	clientMetadataDocumentSchema,
	type ClientMetadata,
	registrationRequestSchema
} from '#lib/schemas/mcp/oauth.ts';
import { oauthClients, oauthGrants } from '../../database/schema.ts';
import type { Queryable } from '../../database/connection.ts';
import { fetchableUrl, type FetchJson } from './safe-fetch.ts';

/**
 * OAuth clients (SPEC-MCP M6). A `client_id` that is an HTTPS URL is a Client ID Metadata
 * Document: fetched safely, cached up to 24 hours, and it must name itself. Anything else must
 * have been registered through `/oauth/register` (DCR), which grants nothing and marks the
 * client unverified. Redirect URIs match exactly, except loopback ones, which match on any port.
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
	{ kind: 'found'; client: ClientRecord } | { kind: 'unknown'; message: string };

/** Checks a client's metadata: public client, acceptable redirects. */
function metadataProblem(metadata: ClientMetadata): string | undefined {
	if (
		metadata.token_endpoint_auth_method !== undefined &&
		metadata.token_endpoint_auth_method !== 'none'
	) {
		return 'Only public clients may connect (token_endpoint_auth_method "none").';
	}
	if (!metadata.redirect_uris.every(isAcceptableRedirect)) {
		return 'Every redirect URI must be https://, or http:// on localhost or 127.0.0.1.';
	}
	return undefined;
}

/**
 * The client behind a `client_id`: a metadata document (fetched again when the cached copy is a
 * day old) or a registered client. Fails closed: a document that cannot be fetched now is refused.
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
			: { kind: 'unknown', message: 'This assistant is not registered with BMuster.' };
	}
	if (row?.fetchedAt !== undefined && row.fetchedAt !== null) {
		if (now - row.fetchedAt.getTime() < DOCUMENT_CACHE_MS) {
			return { kind: 'found', client: toRecord(row) };
		}
	}
	const fetched = await fetchJson(clientId);
	if (fetched.kind === 'failed') {
		return {
			kind: 'unknown',
			message: `BMuster could not read the assistant's metadata document: ${fetched.reason}`
		};
	}
	const document = clientMetadataDocumentSchema.safeParse(fetched.json);
	if (!document.success) {
		return { kind: 'unknown', message: "The assistant's metadata document is not valid." };
	}
	if (document.data.client_id !== clientId) {
		return {
			kind: 'unknown',
			message: "The assistant's metadata document names a different client_id."
		};
	}
	const problem = metadataProblem(document.data);
	if (problem !== undefined) {
		return { kind: 'unknown', message: problem };
	}
	const host = new URL(clientId).host;
	const values = {
		kind: 'metadata-document' as const,
		clientId,
		name: document.data.client_name ?? host,
		clientUri: document.data.client_uri ?? '',
		redirectUris: JSON.stringify(document.data.redirect_uris),
		metadata: JSON.stringify(document.data),
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
				client_name: string;
				redirect_uris: string[];
				token_endpoint_auth_method: 'none';
				grant_types: string[];
				response_types: string[];
			};
			name: string;
	  }
	| { kind: 'refused'; error: 'invalid_client_metadata' | 'invalid_redirect_uri'; message: string };

/** Dynamic Client Registration (RFC 7591): a public client, unverified, that may do nothing yet. */
export function registerClient(database: Queryable, body: unknown, now: number): Registration {
	const request = registrationRequestSchema.safeParse(body);
	if (!request.success) {
		return {
			kind: 'refused',
			error: 'invalid_client_metadata',
			message: 'The registration needs redirect_uris and may hold only the usual fields.'
		};
	}
	const problem = metadataProblem(request.data);
	if (problem !== undefined) {
		return {
			kind: 'refused',
			error: problem.startsWith('Every') ? 'invalid_redirect_uri' : 'invalid_client_metadata',
			message: problem
		};
	}
	pruneUnusedRegistrations(database, now);
	const clientId = `bmc_${randomBytes(18).toString('base64url')}`;
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
			fetchedAt: null,
			createdAt: new Date(now)
		})
		.run();
	return {
		kind: 'registered',
		name,
		reply: {
			client_id: clientId,
			client_id_issued_at: Math.floor(now / 1000),
			client_name: name,
			redirect_uris: request.data.redirect_uris,
			token_endpoint_auth_method: 'none',
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
