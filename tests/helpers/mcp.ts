import { createHash, randomBytes } from 'node:crypto';
import { isHttpError, isRedirect, type RequestEvent } from '@sveltejs/kit';
import type { ConsoleUser } from '#lib/domain/users/user.ts';
import { eq } from 'drizzle-orm';
import type { AppDatabase } from '#lib/server/database/connection.ts';
import { oauthTokens } from '#lib/server/database/schema.ts';
import { createGroup, setGroupMembers } from '#lib/server/services/access/groups.ts';
import { decideConsent } from '#lib/server/services/oauth/authorize.ts';
import { registerClient } from '#lib/server/services/oauth/clients.ts';
import { hashSecret, saveMcpSettings } from '#lib/server/services/oauth/grants.ts';
import { tokenRequest } from '#lib/server/services/oauth/tokens.ts';
import type { FetchJson } from '#lib/server/services/oauth/safe-fetch.ts';
import { done } from './access.ts';
import { testDatabase } from './fake-agent.ts';
import { addTestUser, NOW } from './people.ts';

/** Helpers for the MCP and OAuth tests (SPEC-MCP). */

export const ORIGIN = 'https://bmuster.test';
export const RESOURCE = `${ORIGIN}/mcp`;

/** Claude Code's published Client ID Metadata Document (SPEC-MCP 4.2), as fetched on 2026-11-14. */
export const CLAUDE_CODE_ID = 'https://claude.ai/oauth/claude-code-client-metadata';
export const CLAUDE_CODE_DOCUMENT = {
	client_id: CLAUDE_CODE_ID,
	client_name: 'Claude Code',
	client_uri: 'https://claude.ai',
	redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
	grant_types: ['authorization_code', 'refresh_token'],
	response_types: ['code'],
	token_endpoint_auth_method: 'none'
};

/** A metadata document server that answers only for the documents it holds, counting fetches. */
export function documentServer(documents: Record<string, unknown>): {
	fetchJson: FetchJson;
	fetched: string[];
} {
	const fetched: string[] = [];
	return {
		fetched,
		fetchJson: (url) => {
			fetched.push(url);
			const json = documents[url];
			return Promise.resolve(
				json === undefined ? { kind: 'failed', reason: 'It answered 404.' } : { kind: 'ok', json }
			);
		}
	};
}

export function pkcePair(): { verifier: string; challenge: string } {
	const verifier = randomBytes(32).toString('base64url');
	return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/** Turns MCP on with a connect group holding `memberIds`. Returns the group's id. */
export function enableMcp(database: AppDatabase, adminId: string, memberIds: string[]): string {
	const groupId = done(
		createGroup(
			database,
			'user',
			adminId,
			{ name: `AI people ${crypto.randomUUID()}`, description: '' },
			NOW
		)
	);
	done(setGroupMembers(database, 'user', adminId, groupId, memberIds, NOW));
	const saved = saveMcpSettings(database, adminId, { enabled: true, userGroupId: groupId }, NOW);
	if (saved.kind !== 'changed') throw new Error(saved.message);
	return groupId;
}

export /** A fresh database with an admin (Ada) and two members (Pat, Kim) who may connect assistants. */
async function mcpPeople() {
	const database = testDatabase();
	const admin = await addTestUser(database, {
		email: 'ada@example.com',
		role: 'admin',
		password: null
	});
	const pat = await addTestUser(database, {
		email: 'pat@example.com',
		role: 'member',
		password: null
	});
	const kim = await addTestUser(database, {
		email: 'kim@example.com',
		role: 'member',
		password: null
	});
	enableMcp(database, admin.id, [pat.id, kim.id]);
	return { database, admin, pat, kim };
}

export type EventOptions = {
	method: 'GET' | 'POST' | 'PUT' | 'DELETE';
	headers: Record<string, string>;
	body: string | null;
	session: { kind: 'none' } | { kind: 'signed-in'; user: ConsoleUser };
	address: string;
};

/** Calls a handler, load or action with just enough of a request event for it and its guard. */
export function invoke<E extends RequestEvent, R>(
	handler: (event: E) => R,
	pathAndQuery: string,
	options: EventOptions,
	params: E['params']
): R {
	const url = new URL(pathAndQuery, ORIGIN);
	const partial: Pick<
		RequestEvent,
		'request' | 'url' | 'getClientAddress' | 'locals' | 'params' | 'route'
	> = {
		url,
		request: new Request(url, {
			method: options.method,
			headers: options.headers,
			body: options.body
		}),
		getClientAddress: () => options.address,
		locals: { session: options.session },
		params,
		route: { id: null }
	};
	return handler(partial as E);
}

/** What a load or action threw: a redirect's location, or an HTTP error's status. */
export async function thrown(
	run: () => unknown
): Promise<
	| { kind: 'redirect'; location: string }
	| { kind: 'error'; status: number }
	| { kind: 'returned'; value: unknown }
> {
	try {
		return { kind: 'returned', value: await run() };
	} catch (caught) {
		if (isRedirect(caught)) return { kind: 'redirect', location: caught.location };
		if (isHttpError(caught)) return { kind: 'error', status: caught.status };
		throw caught;
	}
}

/** A JSON-RPC reply from /mcp, whether it came as JSON or as one SSE message. */
export async function rpcReply(response: Response): Promise<unknown> {
	const text = await response.text();
	if ((response.headers.get('content-type') ?? '').startsWith('text/event-stream')) {
		const data = text
			.split('\n')
			.filter((line) => line.startsWith('data: '))
			.map((line) => line.slice('data: '.length));
		return JSON.parse(data.at(-1) ?? 'null');
	}
	return JSON.parse(text);
}

export type Connection = {
	clientId: string;
	grantId: string;
	accessToken: string;
	refreshToken: string;
};

/**
 * A person's assistant connected straight through the services, as the consent screen and token
 * endpoint would: a registered (unverified) client, or Claude Code's metadata document.
 */
export async function connectAssistant(
	database: AppDatabase,
	userId: string,
	kind: 'registered' | 'claude-code',
	now: number
): Promise<Connection> {
	const server = documentServer({ [CLAUDE_CODE_ID]: CLAUDE_CODE_DOCUMENT });
	const redirectUri =
		kind === 'claude-code'
			? 'http://localhost:33333/callback'
			: 'https://claude.ai/api/mcp/auth_callback';
	let clientId = CLAUDE_CODE_ID;
	if (kind === 'registered') {
		const registered = registerClient(
			database,
			{ client_name: 'Helper bot', redirect_uris: [redirectUri] },
			now
		);
		if (registered.kind !== 'registered') throw new Error(registered.message);
		clientId = registered.reply.client_id;
	}
	const pkce = pkcePair();
	const decision = await decideConsent(
		database,
		{
			userId,
			allow: true,
			params: {
				response_type: 'code',
				client_id: clientId,
				redirect_uri: redirectUri,
				code_challenge: pkce.challenge,
				code_challenge_method: 'S256',
				resource: RESOURCE,
				scope: 'machines:read offline_access'
			}
		},
		ORIGIN,
		server.fetchJson,
		now
	);
	if (decision.kind !== 'redirect') throw new Error(`Consent refused: ${decision.kind}`);
	const issued = tokenRequest(
		database,
		{
			grant_type: 'authorization_code',
			code: new URL(decision.location).searchParams.get('code') ?? '',
			redirect_uri: redirectUri,
			code_verifier: pkce.verifier,
			client_id: clientId,
			resource: RESOURCE
		},
		RESOURCE,
		now
	);
	if (issued.kind !== 'issued' || issued.body.refresh_token === undefined) {
		throw new Error('No tokens were issued');
	}
	const grantId = database
		.select({ grantId: oauthTokens.grantId })
		.from(oauthTokens)
		.where(eq(oauthTokens.hash, hashSecret(issued.body.access_token)))
		.get()?.grantId;
	if (grantId === undefined) throw new Error('No grant was made');
	return {
		clientId,
		grantId,
		accessToken: issued.body.access_token,
		refreshToken: issued.body.refresh_token
	};
}
