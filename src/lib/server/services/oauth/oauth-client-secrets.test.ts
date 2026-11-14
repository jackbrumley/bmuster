import { afterEach, describe, expect, it } from 'vitest';
import { testDatabase } from '#tests/helpers/fake-agent.ts';
import {
	CHATGPT_DOCUMENT,
	CHATGPT_ID,
	CHATGPT_REDIRECT,
	CLAUDE_CODE_DOCUMENT,
	documentServer,
	enableMcp,
	ORIGIN,
	pkcePair,
	RESOURCE
} from '#tests/helpers/mcp.ts';
import { addTestUser, NOW } from '#tests/helpers/people.ts';
import { oauthClients, serverLogRecords } from '../../database/schema.ts';
import { stopStoringServerLogs, storeServerLogs } from '../logs/server-log.ts';
import { decideConsent } from './authorize.ts';
import { presentedClient, type PresentedSecret } from './client-auth.ts';
import { registerClient, resolveClient } from './clients.ts';
import { authenticateAccessToken, revokeToken, tokenRequest } from './tokens.ts';

/** SPEC-MCP M31, M33, M34: ChatGPT compatibility and diagnosable refusals. */

const REDIRECT = 'https://chatgpt.com/connector/oauth/abc123';

afterEach(() => {
	stopStoringServerLogs();
});

async function setUp() {
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
	enableMcp(database, admin.id, [pat.id]);
	return { database, pat };
}

type Database = Awaited<ReturnType<typeof setUp>>['database'];

function register(database: Database, method: string) {
	const registered = registerClient(
		database,
		{ client_name: 'ChatGPT', redirect_uris: [REDIRECT], token_endpoint_auth_method: method },
		NOW
	);
	if (registered.kind !== 'registered') throw new Error(registered.message);
	return registered.reply;
}

/** Allow on the consent screen for `clientId`; returns the token request that redeems the code. */
async function allowed(database: Database, userId: string, clientId: string, redirect: string) {
	const pkce = pkcePair();
	const decision = await decideConsent(
		database,
		{
			userId,
			allow: true,
			params: {
				response_type: 'code',
				client_id: clientId,
				redirect_uri: redirect,
				code_challenge: pkce.challenge,
				code_challenge_method: 'S256',
				state: 'state-that-must-not-be-logged',
				resource: RESOURCE,
				scope: 'machines:read offline_access'
			}
		},
		ORIGIN,
		documentServer({ [CHATGPT_ID]: CHATGPT_DOCUMENT }).fetchJson,
		NOW
	);
	if (decision.kind !== 'redirect') throw new Error(decision.kind);
	return {
		grant_type: 'authorization_code' as const,
		code: new URL(decision.location).searchParams.get('code') ?? '',
		redirect_uri: redirect,
		code_verifier: pkce.verifier,
		client_id: clientId,
		resource: RESOURCE
	};
}

function secret(value: string, via: 'client_secret_post' | 'client_secret_basic'): PresentedSecret {
	return { kind: 'secret', via, value };
}

describe('confidential clients (SPEC-MCP M33)', () => {
	it('M33: registration with none gets no secret; with client_secret_post or _basic a secret stored only as its hash', async () => {
		const { database } = await setUp();
		const open = register(database, 'none');
		expect(open.token_endpoint_auth_method).toBe('none');
		expect(open.client_secret).toBeUndefined();
		expect(open.client_secret_expires_at).toBeUndefined();
		for (const method of ['client_secret_post', 'client_secret_basic']) {
			const reply = register(database, method);
			expect(reply.token_endpoint_auth_method).toBe(method);
			expect(reply.client_secret).toMatch(/^bmcs_[A-Za-z0-9_-]{43}$/);
			expect(reply.client_secret_expires_at).toBe(0);
			const stored = JSON.stringify(database.select().from(oauthClients).all());
			expect(stored).not.toContain(reply.client_secret ?? 'missing');
		}
		const lookup = await resolveClient(
			database,
			register(database, 'client_secret_basic').client_id,
			documentServer({}).fetchJson,
			NOW
		);
		expect(lookup).toMatchObject({
			kind: 'found',
			client: { assistant: { name: 'ChatGPT', identity: { kind: 'unverified' } } }
		});
	});

	it('M33: the token endpoint refuses a confidential client with a missing or wrong secret, and takes the right one either way', async () => {
		const { database, pat } = await setUp();
		const client = register(database, 'client_secret_post');
		const right = client.client_secret ?? '';
		for (const presented of [
			{ kind: 'none' } as const,
			secret(`${right}x`, 'client_secret_post'),
			secret('bmcs_guess', 'client_secret_basic')
		]) {
			const request = await allowed(database, pat.id, client.client_id, REDIRECT);
			expect(tokenRequest(database, request, presented, RESOURCE, NOW)).toMatchObject({
				kind: 'error',
				status: 401,
				error: 'invalid_client'
			});
			// The refused attempt did not use the code up.
			expect(
				tokenRequest(database, request, secret(right, 'client_secret_post'), RESOURCE, NOW).kind
			).toBe('issued');
		}
		const viaBasic = await allowed(database, pat.id, client.client_id, REDIRECT);
		const issued = tokenRequest(
			database,
			viaBasic,
			secret(right, 'client_secret_basic'),
			RESOURCE,
			NOW
		);
		if (issued.kind !== 'issued') throw new Error(issued.why);
		const refreshToken = issued.body.refresh_token ?? '';
		const refresh = { grant_type: 'refresh_token' as const, refresh_token: refreshToken };
		expect(
			tokenRequest(
				database,
				{ ...refresh, client_id: client.client_id },
				{ kind: 'none' },
				RESOURCE,
				NOW
			)
		).toMatchObject({ error: 'invalid_client' });
		expect(
			tokenRequest(
				database,
				{ ...refresh, client_id: client.client_id },
				secret(right, 'client_secret_basic'),
				RESOURCE,
				NOW
			).kind
		).toBe('issued');
	});

	it('M33: a public client that sends a secret, or an unknown one, is refused', async () => {
		const { database, pat } = await setUp();
		const open = register(database, 'none');
		const request = await allowed(database, pat.id, open.client_id, REDIRECT);
		expect(
			tokenRequest(database, request, secret('bmcs_made_up', 'client_secret_post'), RESOURCE, NOW)
		).toMatchObject({ error: 'invalid_client' });
		expect(
			tokenRequest(
				database,
				{ ...request, client_id: 'bmc_nobody' },
				secret('bmcs_made_up', 'client_secret_basic'),
				RESOURCE,
				NOW
			)
		).toMatchObject({ error: 'invalid_client' });
		expect(tokenRequest(database, request, { kind: 'none' }, RESOURCE, NOW).kind).toBe('issued');
	});

	it("M33: revoking a confidential client's token needs its secret", async () => {
		const { database, pat } = await setUp();
		const client = register(database, 'client_secret_basic');
		const right = client.client_secret ?? '';
		const request = await allowed(database, pat.id, client.client_id, REDIRECT);
		const issued = tokenRequest(
			database,
			request,
			secret(right, 'client_secret_basic'),
			RESOURCE,
			NOW
		);
		if (issued.kind !== 'issued') throw new Error(issued.why);
		const token = issued.body.access_token;
		const live = () => authenticateAccessToken(database, token, { ip: 'x', userAgent: 'y' }, NOW);
		expect(
			revokeToken(
				database,
				{ token, clientId: client.client_id, secret: secret('wrong', 'client_secret_basic') },
				NOW
			)
		).toMatchObject({ kind: 'refused' });
		expect(
			revokeToken(database, { token, clientId: undefined, secret: { kind: 'none' } }, NOW)
		).toEqual({ kind: 'answered' });
		expect(live().kind).toBe('valid');
		revokeToken(
			database,
			{ token, clientId: client.client_id, secret: secret(right, 'client_secret_basic') },
			NOW
		);
		expect(live().kind).toBe('invalid');
	});

	it('M33: credentials come from HTTP Basic (form-encoded parts) or the form, never both', () => {
		const basic = (id: string, value: string) =>
			`Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(value)}`).toString('base64')}`;
		expect(presentedClient(basic('bmc_a', 'bmcs_b'), {})).toEqual({
			kind: 'presented',
			clientId: 'bmc_a',
			secret: { kind: 'secret', via: 'client_secret_basic', value: 'bmcs_b' }
		});
		expect(presentedClient(basic('https://x.example/c?a=b', 's:t'), {})).toMatchObject({
			clientId: 'https://x.example/c?a=b',
			secret: { value: 's:t' }
		});
		expect(presentedClient(basic('bmc_a', ''), {})).toMatchObject({ secret: { kind: 'none' } });
		expect(presentedClient(null, { client_id: 'bmc_a', client_secret: 'bmcs_b' })).toEqual({
			kind: 'presented',
			clientId: 'bmc_a',
			secret: { kind: 'secret', via: 'client_secret_post', value: 'bmcs_b' }
		});
		expect(presentedClient('Bearer abc', { client_id: 'bmc_a' })).toMatchObject({
			clientId: 'bmc_a',
			secret: { kind: 'none' }
		});
		expect(presentedClient(basic('bmc_a', 'b'), { client_secret: 'c' }).kind).toBe('malformed');
		expect(presentedClient(basic('bmc_a', 'b'), { client_id: 'bmc_z' }).kind).toBe('malformed');
		expect(presentedClient('Basic !!!', {}).kind).toBe('malformed');
	});
});

describe("ChatGPT's metadata document (SPEC-MCP M34)", () => {
	it('M34: a document that prefers private_key_jwt but lists none is a public client; one without none is refused', async () => {
		const { database, pat } = await setUp();
		const request = await allowed(database, pat.id, CHATGPT_ID, CHATGPT_REDIRECT);
		const issued = tokenRequest(database, request, { kind: 'none' }, RESOURCE, NOW);
		expect(issued.kind).toBe('issued');
		const url = 'https://assistant.example/client.json';
		const jwtOnly = {
			...CHATGPT_DOCUMENT,
			client_id: url,
			token_endpoint_auth_methods_supported: ['private_key_jwt']
		};
		const lookup = await resolveClient(
			database,
			url,
			documentServer({ [url]: jwtOnly }).fetchJson,
			NOW
		);
		expect(lookup).toMatchObject({ kind: 'unknown' });
		const claude = await resolveClient(
			database,
			CLAUDE_CODE_DOCUMENT.client_id,
			documentServer({ [CLAUDE_CODE_DOCUMENT.client_id]: CLAUDE_CODE_DOCUMENT }).fetchJson,
			NOW
		);
		expect(claude.kind).toBe('found');
	});
});

describe('refusals are logged (SPEC-MCP M31)', () => {
	it('M31: registrations, grants and refusals write one line each, naming client, redirect and method, never a secret', async () => {
		const { database, pat } = await setUp();
		storeServerLogs(database, 'm31');
		const client = register(database, 'client_secret_post');
		const right = client.client_secret ?? '';
		const request = await allowed(database, pat.id, client.client_id, REDIRECT);
		tokenRequest(
			database,
			request,
			secret('bmcs_wrong_secret', 'client_secret_post'),
			RESOURCE,
			NOW
		);
		tokenRequest(
			database,
			{ ...request, code_verifier: `${request.code_verifier.slice(1)}x` },
			secret(right, 'client_secret_post'),
			RESOURCE,
			NOW
		);
		const second = await allowed(database, pat.id, client.client_id, REDIRECT);
		const issued = tokenRequest(
			database,
			second,
			secret(right, 'client_secret_post'),
			RESOURCE,
			NOW
		);
		if (issued.kind !== 'issued') throw new Error(issued.why);
		registerClient(database, { redirect_uris: ['http://a.example/cb'] }, NOW);
		const lines = database
			.select()
			.from(serverLogRecords)
			.all()
			.filter((record) => record.area === 'oauth')
			.map((record) => record.text);
		const label = `ChatGPT (${client.client_id})`;
		expect(lines).toContainEqual(
			`OAuth register: registered a client (unverified) client=${JSON.stringify(label)} redirect_uri=${JSON.stringify(REDIRECT)} auth_method="client_secret_post"`
		);
		expect(lines).toContainEqual(
			`OAuth token: refused (invalid_client) grant_type authorization_code: the client secret is wrong client=${JSON.stringify(label)} redirect_uri=${JSON.stringify(REDIRECT)} auth_method="client_secret_post"`
		);
		expect(lines.some((line) => line.includes('PKCE code_verifier does not match'))).toBe(true);
		expect(lines.some((line) => line.startsWith('OAuth token: issued tokens'))).toBe(true);
		expect(
			lines.some((line) => line.startsWith('OAuth register: refused (invalid_redirect_uri)'))
		).toBe(true);
		expect(lines.some((line) => line.startsWith('OAuth authorize: allowed by person'))).toBe(true);
		const everything = lines.join('\n');
		for (const kept of [
			right,
			'bmcs_wrong_secret',
			request.code,
			second.code,
			request.code_verifier,
			second.code_verifier,
			issued.body.access_token,
			issued.body.refresh_token ?? 'missing',
			'state-that-must-not-be-logged'
		]) {
			expect(everything).not.toContain(kept);
		}
	});
});
