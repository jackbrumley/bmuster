import type { RequestEvent } from '@sveltejs/kit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type * as SafeFetch from '#lib/server/services/oauth/safe-fetch.ts';
import { database } from '#lib/server/database/app-database.ts';
import { serverLogRecords } from '#lib/server/database/schema.ts';
import { stopStoringServerLogs, storeServerLogs } from '#lib/server/services/logs/server-log.ts';
import { toConsoleUser } from '#lib/server/services/users/users.ts';
import {
	CHATGPT_DOCUMENT,
	CHATGPT_ID,
	CHATGPT_REDIRECT,
	documentServer,
	enableMcp,
	invoke,
	ORIGIN,
	pkcePair,
	RESOURCE,
	thrown
} from '#tests/helpers/mcp.ts';
import { addTestUser } from '#tests/helpers/people.ts';
import { POST as token } from '../../src/routes/oauth/token/+server.ts';
import { POST as revoke } from '../../src/routes/oauth/revoke/+server.ts';
import { POST as register } from '../../src/routes/oauth/register/+server.ts';
import { actions, load } from '../../src/routes/oauth/authorize/+page.server.ts';
import { POST as mcpPost } from '../../src/routes/mcp/+server.ts';
import { GET as resourceAtRoot } from '../../src/routes/.well-known/oauth-protected-resource/+server.ts';
import { GET as resourceForMcp } from '../../src/routes/.well-known/oauth-protected-resource/mcp/+server.ts';
import { GET as serverMetadata } from '../../src/routes/.well-known/oauth-authorization-server/+server.ts';
import { GET as openidConfiguration } from '../../src/routes/.well-known/openid-configuration/+server.ts';

/**
 * SPEC-MCP 14.1 for ChatGPT (M31–M34): the scripted client discovers BMuster at every path
 * ChatGPT may probe, connects with ChatGPT's own metadata document, and connects as a
 * dynamically registered confidential client with `client_secret_basic` and with
 * `client_secret_post`. The server log must explain each step and hold no secret.
 */

/** ChatGPT's metadata document, served by the test in place of chatgpt.com. */
const served = vi.hoisted(() => new Map<string, unknown>());

vi.mock('#lib/server/services/oauth/safe-fetch.ts', async (original) => ({
	...(await original<typeof SafeFetch>()),
	safeFetchJson: (url: string) => documentServer(Object.fromEntries(served)).fetchJson(url)
}));

served.set(CHATGPT_ID, CHATGPT_DOCUMENT);

const ADDRESS = '203.0.113.40';
const CALLBACK = 'https://chatgpt.com/connector/oauth/cb-123';

let pat: ReturnType<typeof toConsoleUser>;
/** Every secret, code and token handed out here: none may reach the log. */
const handedOut: string[] = [];

beforeAll(async () => {
	storeServerLogs(database, 'chatgpt-conformance');
	const admin = await addTestUser(database, {
		email: 'ada@example.com',
		role: 'admin',
		password: null
	});
	pat = toConsoleUser(
		await addTestUser(database, { email: 'pat@example.com', role: 'member', password: null })
	);
	enableMcp(database, admin.id, [pat.id]);
});

afterAll(() => {
	stopStoringServerLogs();
});

/** A request from ChatGPT's servers (no console session). */
function call<E extends RequestEvent>(
	handler: (event: E) => Response | Promise<Response>,
	path: string,
	request: { method: 'GET' | 'POST'; headers: Record<string, string>; body: string | null },
	params: E['params']
): Promise<Response> {
	const options = { ...request, session: { kind: 'none' as const }, address: ADDRESS };
	return Promise.resolve(invoke(handler, path, options, params));
}

async function json(response: Response | Promise<Response>): Promise<unknown> {
	return (await response).json();
}

const GET = { method: 'GET', headers: {}, body: null } as const;

function form(fields: Record<string, string>, headers: Record<string, string> = {}) {
	return {
		method: 'POST' as const,
		headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
		body: new URLSearchParams(fields).toString()
	};
}

function basic(clientId: string, secret: string): Record<string, string> {
	const pair = `${encodeURIComponent(clientId)}:${encodeURIComponent(secret)}`;
	return { authorization: `Basic ${Buffer.from(pair).toString('base64')}` };
}

/** Consent shown, then Allow, as Pat. Returns the code and the PKCE verifier. */
async function allow(clientId: string, redirect: string) {
	const pkce = pkcePair();
	const query = {
		response_type: 'code',
		client_id: clientId,
		redirect_uri: redirect,
		code_challenge: pkce.challenge,
		code_challenge_method: 'S256',
		state: 'chatgpt-state',
		resource: RESOURCE,
		scope: 'machines:read offline_access'
	};
	const session = { kind: 'signed-in' as const, user: pat };
	const path = `/oauth/authorize?${new URLSearchParams(query).toString()}`;
	const shown = await thrown(() => invoke(load, path, { ...GET, session, address: ADDRESS }, {}));
	const allowed = await thrown(() =>
		invoke(
			actions.allow,
			'/oauth/authorize?/allow',
			{ ...form(query, { origin: ORIGIN }), session, address: ADDRESS },
			{}
		)
	);
	if (allowed.kind !== 'redirect') throw new Error(JSON.stringify(allowed));
	const back = new URL(allowed.location);
	expect(back.origin + back.pathname).toBe(redirect);
	expect(back.searchParams.get('iss')).toBe(ORIGIN);
	const code = back.searchParams.get('code') ?? '';
	handedOut.push(code, pkce.verifier);
	return { shown, code, verifier: pkce.verifier };
}

const tokenReply = z.object({ access_token: z.string(), refresh_token: z.string() });

async function issued(response: Response): Promise<z.infer<typeof tokenReply>> {
	expect(response.status).toBe(200);
	const body = tokenReply.parse(await response.json());
	handedOut.push(body.access_token, body.refresh_token);
	return body;
}

function listTools(accessToken: string): Promise<Response> {
	return Promise.resolve(
		call(
			mcpPost,
			'/mcp',
			{
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					accept: 'application/json, text/event-stream',
					authorization: `Bearer ${accessToken}`,
					'mcp-protocol-version': '2025-11-25'
				},
				body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
			},
			{}
		)
	);
}

const registration = z.object({
	client_id: z.string(),
	client_secret: z.string(),
	client_secret_expires_at: z.literal(0),
	token_endpoint_auth_method: z.string()
});

async function registerConfidential(method: 'client_secret_basic' | 'client_secret_post') {
	const response = await call(
		register,
		'/oauth/register',
		{
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				client_name: 'ChatGPT',
				redirect_uris: [CALLBACK],
				token_endpoint_auth_method: method,
				grant_types: ['authorization_code', 'refresh_token'],
				response_types: ['code']
			})
		},
		{}
	);
	expect(response.status).toBe(201);
	const client = registration.parse(await response.json());
	expect(client.token_endpoint_auth_method).toBe(method);
	handedOut.push(client.client_secret);
	return client;
}

describe('ChatGPT conformance (SPEC-MCP M31–M34)', () => {
	it('M32: resource metadata at the root and at /mcp, and openid-configuration, are the same documents', async () => {
		const atRoot = await json(
			call(resourceAtRoot, '/.well-known/oauth-protected-resource', GET, {})
		);
		const atMcp = await json(
			call(resourceForMcp, '/.well-known/oauth-protected-resource/mcp', GET, {})
		);
		expect(atRoot).toEqual(atMcp);
		expect(atRoot).toMatchObject({ resource: RESOURCE, authorization_servers: [ORIGIN] });
		const oauth = await json(
			call(serverMetadata, '/.well-known/oauth-authorization-server', GET, {})
		);
		const openid = await json(
			call(openidConfiguration, '/.well-known/openid-configuration', GET, {})
		);
		expect(openid).toEqual(oauth);
		expect(openid).toMatchObject({
			issuer: ORIGIN,
			code_challenge_methods_supported: ['S256'],
			token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic']
		});
	});

	it("M34: ChatGPT's metadata document connects as a verified public client with PKCE", async () => {
		const { shown, code, verifier } = await allow(CHATGPT_ID, CHATGPT_REDIRECT);
		expect(shown).toMatchObject({
			kind: 'returned',
			value: {
				view: {
					kind: 'ask',
					assistant: { name: 'ChatGPT', identity: { kind: 'verified', host: 'chatgpt.com' } }
				}
			}
		});
		const tokens = await issued(
			await call(
				token,
				'/oauth/token',
				form({
					grant_type: 'authorization_code',
					code,
					redirect_uri: CHATGPT_REDIRECT,
					code_verifier: verifier,
					client_id: CHATGPT_ID,
					resource: RESOURCE
				}),
				{}
			)
		);
		expect((await listTools(tokens.access_token)).status).toBe(200);
	});

	it('M33: a client_secret_basic client connects, refreshes and revokes with Basic; a wrong secret gets 401', async () => {
		const client = await registerConfidential('client_secret_basic');
		const { code, verifier } = await allow(client.client_id, CALLBACK);
		const exchange = {
			grant_type: 'authorization_code',
			code,
			redirect_uri: CALLBACK,
			code_verifier: verifier,
			resource: RESOURCE
		};
		const wrong = await call(
			token,
			'/oauth/token',
			form(exchange, basic(client.client_id, `${client.client_secret}x`)),
			{}
		);
		expect(wrong.status).toBe(401);
		expect(wrong.headers.get('www-authenticate')).toBe('Basic realm="BMuster"');
		expect(await wrong.json()).toMatchObject({ error: 'invalid_client' });
		const unsigned = await call(
			token,
			'/oauth/token',
			form({ ...exchange, client_id: client.client_id }),
			{}
		);
		expect(unsigned.status).toBe(401);
		const first = await issued(
			await call(
				token,
				'/oauth/token',
				form(exchange, basic(client.client_id, client.client_secret)),
				{}
			)
		);
		const second = await issued(
			await call(
				token,
				'/oauth/token',
				form(
					{ grant_type: 'refresh_token', refresh_token: first.refresh_token },
					basic(client.client_id, client.client_secret)
				),
				{}
			)
		);
		expect((await listTools(second.access_token)).status).toBe(200);
		const refused = await call(
			revoke,
			'/oauth/revoke',
			form({ token: second.refresh_token }, basic(client.client_id, 'bmcs_wrong')),
			{}
		);
		expect(refused.status).toBe(401);
		const revoked = await call(
			revoke,
			'/oauth/revoke',
			form({ token: second.refresh_token }, basic(client.client_id, client.client_secret)),
			{}
		);
		expect(revoked.status).toBe(200);
		expect((await listTools(second.access_token)).status).toBe(401);
	});

	it('M33: a client_secret_post client connects with the secret in the form; Basic and form together are refused', async () => {
		const client = await registerConfidential('client_secret_post');
		const { code, verifier } = await allow(client.client_id, CALLBACK);
		const exchange = {
			grant_type: 'authorization_code',
			code,
			redirect_uri: CALLBACK,
			code_verifier: verifier,
			client_id: client.client_id
		};
		const both = await call(
			token,
			'/oauth/token',
			form(
				{ ...exchange, client_secret: client.client_secret },
				basic(client.client_id, client.client_secret)
			),
			{}
		);
		expect(both.status).toBe(401);
		const tokens = await issued(
			await call(
				token,
				'/oauth/token',
				form({ ...exchange, client_secret: client.client_secret }),
				{}
			)
		);
		expect((await listTools(tokens.access_token)).status).toBe(200);
	});

	it('M31: the server log explains the attempt and holds no secret, code, verifier or token', async () => {
		expect((await listTools('bmat_unknown')).status).toBe(401);
		const lines = database
			.select()
			.from(serverLogRecords)
			.all()
			.filter((record) => record.area === 'oauth')
			.map((record) => `${record.level} ${record.text}`);
		for (const expected of [
			'info OAuth register: registered a client (unverified)',
			'info OAuth token: refused (invalid_client) grant_type authorization_code: the client secret is wrong',
			'info OAuth token: refused (invalid_client) grant_type authorization_code: the client registered client_secret_basic but sent no secret',
			'info OAuth token: refused (invalid_client): Send the client secret one way only',
			'info OAuth token: issued tokens (refresh_token',
			'info OAuth revoke: refused (invalid_client): the client secret is wrong',
			'info OAuth revoke: ended the grant',
			'info OAuth mcp: answered 401 invalid_token: the access token is unknown',
			'info OAuth authorize: allowed by person'
		]) {
			expect(
				lines.some((line) => line.startsWith(expected)),
				expected
			).toBe(true);
		}
		const everything = lines.join('\n');
		expect(handedOut.length).toBeGreaterThan(10);
		for (const secret of handedOut) {
			expect(everything).not.toContain(secret);
		}
		expect(everything).not.toContain('chatgpt-state');
	});
});
