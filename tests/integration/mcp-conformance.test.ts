import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { getMachineOutput, listMachinesOutput } from '#lib/schemas/mcp/tools.ts';
import type * as SafeFetch from '#lib/server/services/oauth/safe-fetch.ts';
import { database } from '#lib/server/database/app-database.ts';
import { machines } from '#lib/server/database/schema.ts';
import { toConsoleUser } from '#lib/server/services/users/users.ts';
import { grantAccess } from '#tests/helpers/access.ts';
import { enrolFakeAgent } from '#tests/helpers/fake-agent.ts';
import {
	CLAUDE_CODE_DOCUMENT,
	CLAUDE_CODE_ID,
	documentServer,
	enableMcp,
	invoke,
	type EventOptions,
	ORIGIN,
	pkcePair,
	RESOURCE,
	rpcReply,
	thrown
} from '#tests/helpers/mcp.ts';
import { addTestUser, NOW } from '#tests/helpers/people.ts';
import { GET as protectedResource } from '../../src/routes/.well-known/oauth-protected-resource/mcp/+server.ts';
import { GET as authorizationServer } from '../../src/routes/.well-known/oauth-authorization-server/+server.ts';
import { POST as mcpPost } from '../../src/routes/mcp/+server.ts';
import { actions, load } from '../../src/routes/oauth/authorize/+page.server.ts';
import { POST as register } from '../../src/routes/oauth/register/+server.ts';
import { POST as revoke } from '../../src/routes/oauth/revoke/+server.ts';
import { POST as token } from '../../src/routes/oauth/token/+server.ts';

/**
 * SPEC-MCP 14.1, the gate: a scripted MCP client against BMuster's own handlers, in process, on
 * the test's in-memory database. Discovery → CIMD and DCR clients → authorise with PKCE → token →
 * `initialize` / `server/discover` → `tools/list` → `list_machines`, plus the refusals the spec
 * names. The metadata documents are served by the test.
 */

const documents = vi.hoisted(() => ({ served: new Map<string, unknown>() }));

vi.mock('#lib/server/services/oauth/safe-fetch.ts', async (original) => ({
	...(await original<typeof SafeFetch>()),
	safeFetchJson: (url: string) =>
		documentServer(Object.fromEntries(documents.served)).fetchJson(url)
}));

documents.served.set(CLAUDE_CODE_ID, CLAUDE_CODE_DOCUMENT);

const ADDRESS = '203.0.113.20';

type Session = { kind: 'none' } | { kind: 'signed-in'; user: ReturnType<typeof toConsoleUser> };

/** A GET as a browser or client sends it. */
function getting(session: Session = { kind: 'none' }): EventOptions {
	return { method: 'GET', headers: {}, body: null, session, address: ADDRESS };
}

/** A form-encoded POST from this server's own pages (the origin check passes). */
function posting(
	fields: Record<string, string>,
	session: Session = { kind: 'none' }
): EventOptions {
	return {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN },
		body: new URLSearchParams(fields).toString(),
		session,
		address: ADDRESS
	};
}

const MODERN = '2026-07-28';

function mcp(
	accessToken: string | undefined,
	message: { id: number; method: string; params: Record<string, unknown> },
	era: 'legacy' | 'modern'
): Promise<Response> {
	const headers: Record<string, string> = {
		'content-type': 'application/json',
		accept: 'application/json, text/event-stream'
	};
	if (accessToken !== undefined) headers['authorization'] = `Bearer ${accessToken}`;
	const params =
		era === 'modern'
			? {
					...message.params,
					_meta: {
						'io.modelcontextprotocol/protocolVersion': MODERN,
						'io.modelcontextprotocol/clientCapabilities': {},
						'io.modelcontextprotocol/clientInfo': { name: 'bmuster-test', version: '1' }
					}
				}
			: message.params;
	if (era === 'modern') {
		headers['mcp-protocol-version'] = MODERN;
		headers['mcp-method'] = message.method;
		const name = params['name'];
		if (typeof name === 'string') headers['mcp-name'] = name;
	} else if (message.method !== 'initialize') {
		headers['mcp-protocol-version'] = '2025-11-25';
	}
	return Promise.resolve(
		invoke(
			mcpPost,
			'/mcp',
			{
				method: 'POST',
				headers,
				body: JSON.stringify({ jsonrpc: '2.0', ...message, params }),
				session: { kind: 'none' },
				address: ADDRESS
			},
			{}
		)
	);
}

let pat: ReturnType<typeof toConsoleUser>;
let mint: string;

beforeAll(async () => {
	const admin = await addTestUser(database, {
		email: 'ada@example.com',
		role: 'admin',
		password: null
	});
	pat = toConsoleUser(
		await addTestUser(database, { email: 'pat@example.com', role: 'member', password: null })
	);
	mint = enrolFakeAgent(database, NOW).machineId;
	const hidden = enrolFakeAgent(database, NOW).machineId;
	database.update(machines).set({ name: 'mint' }).where(eq(machines.id, mint)).run();
	database.update(machines).set({ name: 'payroll' }).where(eq(machines.id, hidden)).run();
	grantAccess(database, {
		adminId: admin.id,
		name: 'Helpers',
		memberIds: [pat.id],
		machineIds: [mint, hidden],
		permissions: ['view', 'terminal'],
		consent: 'unattended'
	});
	grantAccess(database, {
		adminId: admin.id,
		name: 'AI helpers',
		memberIds: [pat.id],
		machineIds: [mint],
		permissions: ['view', 'ai-commands'],
		consent: 'unattended'
	});
	enableMcp(database, admin.id, [pat.id]);
});

type Authorised = { code: string; state: string; iss: string };

/** The browser half: consent load, then Allow. Returns what came back on the redirect URI. */
async function authorise(query: Record<string, string>): Promise<Authorised> {
	const path = `/oauth/authorize?${new URLSearchParams(query).toString()}`;
	const shown = await thrown(() =>
		invoke(load, path, getting({ kind: 'signed-in', user: pat }), {})
	);
	if (shown.kind !== 'returned') throw new Error(`Consent did not show: ${JSON.stringify(shown)}`);
	const allowed = await thrown(() =>
		invoke(
			actions.allow,
			`/oauth/authorize?/allow`,
			posting(query, { kind: 'signed-in', user: pat }),
			{}
		)
	);
	if (allowed.kind !== 'redirect')
		throw new Error(`Allow did not redirect: ${JSON.stringify(allowed)}`);
	const back = new URL(allowed.location);
	return {
		code: back.searchParams.get('code') ?? '',
		state: back.searchParams.get('state') ?? '',
		iss: back.searchParams.get('iss') ?? ''
	};
}

function exchange(fields: Record<string, string>): Promise<Response> {
	return Promise.resolve(invoke(token, '/oauth/token', posting(fields), {}));
}

const tokenReply = z.object({
	access_token: z.string(),
	refresh_token: z.string().optional(),
	token_type: z.string(),
	expires_in: z.number()
});

type Tokens = { access_token: string; refresh_token: string | undefined };

async function tokens(response: Response): Promise<Tokens> {
	expect(response.status).toBe(200);
	expect(response.headers.get('cache-control')).toBe('no-store');
	const body = tokenReply.parse(await response.json());
	expect(body.token_type).toBe('Bearer');
	expect(body.expires_in).toBe(3600);
	expect(body.access_token.startsWith('bmat_')).toBe(true);
	return { access_token: body.access_token, refresh_token: body.refresh_token };
}

/** A full connection as Claude Code makes it, on a loopback port. */
async function connectClaudeCode(host: 'localhost' | '127.0.0.1', port: number): Promise<Tokens> {
	const pkce = pkcePair();
	const redirect = `http://${host}:${String(port)}/callback`;
	const back = await authorise({
		response_type: 'code',
		client_id: CLAUDE_CODE_ID,
		redirect_uri: redirect,
		code_challenge: pkce.challenge,
		code_challenge_method: 'S256',
		state: 'state-123',
		resource: RESOURCE,
		scope: 'machines:read offline_access'
	});
	expect(back.state).toBe('state-123');
	expect(back.iss).toBe(ORIGIN);
	return tokens(
		await exchange({
			grant_type: 'authorization_code',
			code: back.code,
			redirect_uri: redirect,
			code_verifier: pkce.verifier,
			client_id: CLAUDE_CODE_ID,
			resource: RESOURCE
		})
	);
}

describe('MCP conformance (SPEC-MCP 14.1)', () => {
	it('discovery: 401 with the challenge, then both well-known documents', async () => {
		const challenge = await mcp(undefined, { id: 1, method: 'tools/list', params: {} }, 'legacy');
		expect(challenge.status).toBe(401);
		expect(challenge.headers.get('www-authenticate')).toBe(
			`Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp", scope="machines:read offline_access"`
		);
		const resource = await Promise.resolve(
			invoke(protectedResource, '/.well-known/oauth-protected-resource/mcp', getting(), {})
		);
		expect(await resource.json()).toMatchObject({
			resource: RESOURCE,
			authorization_servers: [ORIGIN]
		});
		const server = await Promise.resolve(
			invoke(authorizationServer, '/.well-known/oauth-authorization-server', getting(), {})
		);
		expect(await server.json()).toMatchObject({
			issuer: ORIGIN,
			authorization_endpoint: `${ORIGIN}/oauth/authorize`,
			token_endpoint: `${ORIGIN}/oauth/token`,
			registration_endpoint: `${ORIGIN}/oauth/register`,
			code_challenge_methods_supported: ['S256'],
			client_id_metadata_document_supported: true,
			token_endpoint_auth_methods_supported: ['none'],
			authorization_response_iss_parameter_supported: true
		});
	});

	it('the consent screen needs a console session: signed out goes to sign-in and back', async () => {
		const query = new URLSearchParams({ client_id: CLAUDE_CODE_ID }).toString();
		const outcome = await thrown(() => invoke(load, `/oauth/authorize?${query}`, getting(), {}));
		expect(outcome).toEqual({
			kind: 'redirect',
			location: `/login?returnTo=${encodeURIComponent(`/oauth/authorize?${query}`)}`
		});
	});

	it('CIMD client on loopback (any port, localhost and 127.0.0.1): connect, initialize, tools/list, list_machines', async () => {
		await connectClaudeCode('127.0.0.1', 41_234);
		const connected = await connectClaudeCode('localhost', 53_999);
		const initialized = await mcp(
			connected.access_token,
			{
				id: 1,
				method: 'initialize',
				params: {
					protocolVersion: '2025-11-25',
					capabilities: {},
					clientInfo: { name: 'bmuster-test', version: '1' }
				}
			},
			'legacy'
		);
		expect(initialized.status).toBe(200);
		expect(await rpcReply(initialized)).toMatchObject({
			result: { protocolVersion: '2025-11-25', serverInfo: { name: 'BMuster' } }
		});
		const listed = await rpcReply(
			await mcp(connected.access_token, { id: 2, method: 'tools/list', params: {} }, 'legacy')
		);
		expect(listed).toMatchObject({
			result: { tools: [{ name: 'list_machines' }, { name: 'get_machine' }] }
		});
		const called = await rpcReply(
			await mcp(
				connected.access_token,
				{ id: 3, method: 'tools/call', params: { name: 'list_machines', arguments: {} } },
				'legacy'
			)
		);
		const result = (called as { result: { structuredContent: unknown } }).result;
		const parsed = listMachinesOutput.parse(result.structuredContent);
		expect(parsed.machines.map((machine) => machine.name)).toEqual(['mint']);
		expect(parsed.total).toBe(1);
	});

	it('2026-07-28: server/discover and tools/call, every structuredContent valid; other versions refused', async () => {
		const connected = await connectClaudeCode('localhost', 50_001);
		const discovered = await rpcReply(
			await mcp(connected.access_token, { id: 1, method: 'server/discover', params: {} }, 'modern')
		);
		expect(discovered).toMatchObject({ result: { supportedVersions: [MODERN] } });
		const machine = await rpcReply(
			await mcp(
				connected.access_token,
				{
					id: 2,
					method: 'tools/call',
					params: { name: 'get_machine', arguments: { machine: 'mint' } }
				},
				'modern'
			)
		);
		const result = (machine as { result: { structuredContent: unknown } }).result;
		expect(getMachineOutput.parse(result.structuredContent).id).toBe(mint);
		const hidden = await rpcReply(
			await mcp(
				connected.access_token,
				{
					id: 3,
					method: 'tools/call',
					params: { name: 'get_machine', arguments: { machine: 'payroll' } }
				},
				'modern'
			)
		);
		expect(hidden).toMatchObject({ result: { isError: true } });
		const unsupported = await invoke(
			mcpPost,
			'/mcp',
			{
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					accept: 'application/json, text/event-stream',
					authorization: `Bearer ${connected.access_token}`,
					'mcp-protocol-version': '2099-01-01'
				},
				body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }),
				session: { kind: 'none' },
				address: ADDRESS
			},
			{}
		);
		expect(unsupported.status).toBe(400);
		const mismatched = await invoke(
			mcpPost,
			'/mcp',
			{
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					accept: 'application/json, text/event-stream',
					authorization: `Bearer ${connected.access_token}`,
					'mcp-protocol-version': MODERN,
					'mcp-method': 'tools/list'
				},
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 5,
					method: 'server/discover',
					params: {
						_meta: {
							'io.modelcontextprotocol/protocolVersion': MODERN,
							'io.modelcontextprotocol/clientCapabilities': {},
							'io.modelcontextprotocol/clientInfo': { name: 'bmuster-test', version: '1' }
						}
					}
				}),
				session: { kind: 'none' },
				address: ADDRESS
			},
			{}
		);
		expect(mismatched.status).toBe(400);
	});

	it('DCR client: registered, unverified on the consent screen, then connected', async () => {
		const registered = await invoke(
			register,
			'/oauth/register',
			{
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					client_name: 'Some assistant',
					redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
					token_endpoint_auth_method: 'none'
				}),
				session: { kind: 'none' },
				address: ADDRESS
			},
			{}
		);
		expect(registered.status).toBe(201);
		const client = z.object({ client_id: z.string() }).parse(await registered.json());
		const pkce = pkcePair();
		const query = {
			response_type: 'code',
			client_id: client.client_id,
			redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
			code_challenge: pkce.challenge,
			code_challenge_method: 'S256',
			state: 'dcr',
			resource: RESOURCE
		};
		const shown = await thrown(() =>
			invoke(
				load,
				`/oauth/authorize?${new URLSearchParams(query).toString()}`,
				getting({ kind: 'signed-in', user: pat }),
				{}
			)
		);
		expect(shown).toMatchObject({
			kind: 'returned',
			value: {
				view: {
					kind: 'ask',
					assistant: { name: 'Some assistant', identity: { kind: 'unverified' } },
					redirect: { kind: 'web', host: 'claude.ai' }
				}
			}
		});
		const back = await authorise(query);
		const issued = await tokens(
			await exchange({
				grant_type: 'authorization_code',
				code: back.code,
				redirect_uri: query.redirect_uri,
				code_verifier: pkce.verifier,
				client_id: client.client_id
			})
		);
		// No offline_access asked for: no refresh token.
		expect(issued.refresh_token).toBeUndefined();
	});

	it('PKCE is required and S256 only; the resource must be this /mcp; a redirect not registered goes nowhere', async () => {
		const pkce = pkcePair();
		const base = {
			response_type: 'code',
			client_id: CLAUDE_CODE_ID,
			redirect_uri: 'http://localhost:4000/callback',
			code_challenge: pkce.challenge,
			code_challenge_method: 'S256',
			state: 's',
			resource: RESOURCE
		};
		const signedIn: Session = { kind: 'signed-in', user: pat };
		const open = (query: Record<string, string>) =>
			thrown(() =>
				invoke(
					load,
					`/oauth/authorize?${new URLSearchParams(query).toString()}`,
					getting(signedIn),
					{}
				)
			);
		const plain = await open({ ...base, code_challenge_method: 'plain' });
		expect(plain.kind === 'redirect' && new URL(plain.location).searchParams.get('error')).toBe(
			'invalid_request'
		);
		const { code_challenge: _dropped, ...missing } = base;
		const noChallenge = await open(missing);
		expect(
			noChallenge.kind === 'redirect' && new URL(noChallenge.location).searchParams.get('error')
		).toBe('invalid_request');
		const wrongResource = await open({ ...base, resource: 'https://elsewhere.example/mcp' });
		expect(
			wrongResource.kind === 'redirect' && new URL(wrongResource.location).searchParams.get('iss')
		).toBe(ORIGIN);
		expect(
			wrongResource.kind === 'redirect' && new URL(wrongResource.location).searchParams.get('error')
		).toBe('invalid_target');
		const strange = await open({ ...base, redirect_uri: 'https://attacker.example/callback' });
		expect(strange).toMatchObject({ kind: 'returned', value: { view: { kind: 'invalid' } } });
	});

	it('codes are single use: a reused code is refused and ends what it bought', async () => {
		const pkce = pkcePair();
		const redirect = 'http://localhost:4100/callback';
		const back = await authorise({
			response_type: 'code',
			client_id: CLAUDE_CODE_ID,
			redirect_uri: redirect,
			code_challenge: pkce.challenge,
			code_challenge_method: 'S256',
			resource: RESOURCE
		});
		const fields = {
			grant_type: 'authorization_code',
			code: back.code,
			redirect_uri: redirect,
			code_verifier: pkce.verifier,
			client_id: CLAUDE_CODE_ID
		};
		const first = await tokens(await exchange(fields));
		const again = await exchange(fields);
		expect(again.status).toBe(400);
		expect(await again.json()).toMatchObject({ error: 'invalid_grant' });
		const after = await mcp(
			first.access_token,
			{ id: 1, method: 'tools/list', params: {} },
			'legacy'
		);
		expect(after.status).toBe(401);
	});

	it('refresh rotates; a used refresh token presented again ends the grant', async () => {
		const first = await connectClaudeCode('localhost', 4200);
		const refresh = (refreshToken: string) =>
			exchange({
				grant_type: 'refresh_token',
				refresh_token: refreshToken,
				client_id: CLAUDE_CODE_ID
			});
		const second = await tokens(await refresh(first.refresh_token ?? ''));
		expect(second.refresh_token).not.toBe(first.refresh_token);
		const third = await tokens(await refresh(second.refresh_token ?? ''));
		const reused = await refresh(first.refresh_token ?? '');
		expect(reused.status).toBe(400);
		expect(await reused.json()).toMatchObject({ error: 'invalid_grant' });
		const dead = await mcp(
			third.access_token,
			{ id: 1, method: 'tools/list', params: {} },
			'legacy'
		);
		expect(dead.status).toBe(401);
		const deadRefresh = await refresh(third.refresh_token ?? '');
		expect(deadRefresh.status).toBe(400);
	});

	it('revocation: a revoked refresh token disconnects the grant', async () => {
		const connected = await connectClaudeCode('localhost', 4300);
		const answer = await invoke(
			revoke,
			'/oauth/revoke',
			posting({
				token: connected.refresh_token ?? '',
				client_id: CLAUDE_CODE_ID
			}),
			{}
		);
		expect(answer.status).toBe(200);
		const after = await mcp(
			connected.access_token,
			{ id: 1, method: 'tools/list', params: {} },
			'legacy'
		);
		expect(after.status).toBe(401);
	});
});
