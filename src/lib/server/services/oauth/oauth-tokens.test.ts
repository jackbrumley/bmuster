import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
	connectAssistant,
	documentServer,
	enableMcp,
	ORIGIN,
	pkcePair,
	RESOURCE
} from '#tests/helpers/mcp.ts';
import { testDatabase } from '#tests/helpers/fake-agent.ts';
import { addTestUser, NOW } from '#tests/helpers/people.ts';
import { oauthCodes, oauthGrants, oauthTokens, userGroupMembers } from '../../database/schema.ts';
import { disableUser } from '../users/users.ts';
import { decideConsent } from './authorize.ts';
import { registerClient } from './clients.ts';
import { saveMcpSettings, endIneligibleGrants, LIFETIMES } from './grants.ts';
import { readMcpSettings } from './mcp-settings.ts';
import { authenticateAccessToken, pkceMatches, revokeToken, tokenRequest } from './tokens.ts';

const CLIENT = { ip: '198.51.100.7', userAgent: 'Vitest' };
const DAY = 24 * 60 * 60_000;

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
	const groupId = enableMcp(database, admin.id, [pat.id]);
	return { database, admin, pat, groupId };
}

/** A fresh code from Allow on the consent screen, and the token request that redeems it. */
async function freshCode(database: ReturnType<typeof testDatabase>, userId: string) {
	const redirectUri = 'https://claude.ai/api/mcp/auth_callback';
	const registered = registerClient(
		database,
		{ client_name: 'Helper bot', redirect_uris: [redirectUri] },
		NOW
	);
	if (registered.kind !== 'registered') throw new Error(registered.message);
	const pkce = pkcePair();
	const decision = await decideConsent(
		database,
		{
			userId,
			allow: true,
			params: {
				response_type: 'code',
				client_id: registered.reply.client_id,
				redirect_uri: redirectUri,
				code_challenge: pkce.challenge,
				code_challenge_method: 'S256',
				resource: RESOURCE
			}
		},
		ORIGIN,
		documentServer({}).fetchJson,
		NOW
	);
	if (decision.kind !== 'redirect') throw new Error(decision.kind);
	return {
		request: {
			grant_type: 'authorization_code' as const,
			code: new URL(decision.location).searchParams.get('code') ?? '',
			redirect_uri: redirectUri,
			code_verifier: pkce.verifier,
			client_id: registered.reply.client_id,
			resource: RESOURCE
		}
	};
}

function refresh(
	database: ReturnType<typeof testDatabase>,
	refreshToken: string,
	clientId: string,
	now: number
) {
	return tokenRequest(
		database,
		{ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId },
		{ kind: 'none' },
		RESOURCE,
		now
	);
}

describe('codes and tokens (SPEC-MCP M8)', () => {
	it('M8: PKCE is S256 of the verifier; anything else fails', () => {
		const pair = pkcePair();
		expect(pkceMatches(pair.verifier, pair.challenge)).toBe(true);
		expect(pkceMatches(`${pair.verifier}x`, pair.challenge)).toBe(false);
		// "plain": the verifier itself sent as the challenge.
		expect(pkceMatches(pair.verifier, pair.verifier)).toBe(false);
		expect(pkceMatches('short', pair.challenge)).toBe(false);
	});

	it('M8: a code is refused after 60 seconds, with the wrong verifier, redirect, client or resource', async () => {
		const { database, pat } = await setUp();
		const spoilt = [
			{ at: NOW + LIFETIMES.codeMs, change: {}, error: 'invalid_grant' },
			{ at: NOW, change: { code_verifier: pkcePair().verifier }, error: 'invalid_grant' },
			{ at: NOW, change: { redirect_uri: 'https://claude.ai/other' }, error: 'invalid_grant' },
			{ at: NOW, change: { client_id: 'bmc_someone-else' }, error: 'invalid_grant' },
			{ at: NOW, change: { resource: 'https://elsewhere.example/mcp' }, error: 'invalid_target' }
		] as const;
		for (const attempt of spoilt) {
			const issued = await freshCode(database, pat.id);
			expect(
				tokenRequest(
					database,
					{ ...issued.request, ...attempt.change },
					{ kind: 'none' },
					RESOURCE,
					attempt.at
				)
			).toMatchObject({ kind: 'error', error: attempt.error });
		}
		const good = await freshCode(database, pat.id);
		expect(tokenRequest(database, good.request, { kind: 'none' }, RESOURCE, NOW).kind).toBe(
			'issued'
		);
	});

	it('M8: refresh answers invalid_grant for an unknown token or another client', async () => {
		const { database, pat } = await setUp();
		const connection = await connectAssistant(database, pat.id, 'claude-code', NOW);
		expect(refresh(database, 'bmrt_unknown', connection.clientId, NOW)).toMatchObject({
			error: 'invalid_grant'
		});
		expect(refresh(database, connection.refreshToken, 'someone-else', NOW)).toMatchObject({
			error: 'invalid_grant'
		});
	});

	it('M8: revoking an access token stops it at once', async () => {
		const { database, pat } = await setUp();
		const connection = await connectAssistant(database, pat.id, 'claude-code', NOW);
		revokeToken(
			database,
			{ token: connection.accessToken, clientId: undefined, secret: { kind: 'none' } },
			NOW
		);
		expect(authenticateAccessToken(database, connection.accessToken, CLIENT, NOW).kind).toBe(
			'invalid'
		);
	});
});

describe('lifetimes (SPEC-MCP M9)', () => {
	it('M9: tokens are opaque, prefixed, and stored only as SHA-256', async () => {
		const { database, pat } = await setUp();
		const connection = await connectAssistant(database, pat.id, 'claude-code', NOW);
		expect(connection.accessToken.startsWith('bmat_')).toBe(true);
		expect(connection.refreshToken.startsWith('bmrt_')).toBe(true);
		const stored = database.select().from(oauthTokens).all();
		expect(stored.every((row) => /^[0-9a-f]{64}$/.test(row.hash))).toBe(true);
		const dump = JSON.stringify([stored, database.select().from(oauthCodes).all()]);
		expect(dump).not.toContain(connection.accessToken);
		expect(dump).not.toContain(connection.refreshToken);
	});

	it('M9: an access token lasts one hour', async () => {
		const { database, pat } = await setUp();
		const connection = await connectAssistant(database, pat.id, 'claude-code', NOW);
		expect(authenticateAccessToken(database, connection.accessToken, CLIENT, NOW).kind).toBe(
			'valid'
		);
		expect(
			authenticateAccessToken(database, connection.accessToken, CLIENT, NOW + LIFETIMES.accessMs)
				.kind
		).toBe('invalid');
	});

	it('M9: refresh rotates; 7 days idle ends it', async () => {
		const { database, pat } = await setUp();
		const connection = await connectAssistant(database, pat.id, 'claude-code', NOW);
		const rotated = refresh(database, connection.refreshToken, connection.clientId, NOW + DAY);
		if (rotated.kind !== 'issued' || rotated.body.refresh_token === undefined) {
			throw new Error('not rotated');
		}
		expect(rotated.body.refresh_token).not.toBe(connection.refreshToken);
		expect(
			refresh(database, rotated.body.refresh_token, connection.clientId, NOW + 8 * DAY + 1)
		).toMatchObject({ error: 'invalid_grant' });
		const grant = database
			.select()
			.from(oauthGrants)
			.where(eq(oauthGrants.id, connection.grantId))
			.get();
		expect(grant?.endedReason).toBe('expired');
	});

	it('M9: 30 days at most, however often it is used', async () => {
		const { database, pat } = await setUp();
		const connection = await connectAssistant(database, pat.id, 'claude-code', NOW);
		let token = connection.refreshToken;
		for (let day = 5; day < 30; day += 5) {
			const next = refresh(database, token, connection.clientId, NOW + day * DAY);
			if (next.kind !== 'issued' || next.body.refresh_token === undefined) {
				throw new Error(`refused on day ${String(day)}`);
			}
			token = next.body.refresh_token;
		}
		expect(refresh(database, token, connection.clientId, NOW + 30 * DAY)).toMatchObject({
			error: 'invalid_grant'
		});
	});

	it('M9: a refresh token used twice ends the whole grant', async () => {
		const { database, pat } = await setUp();
		const connection = await connectAssistant(database, pat.id, 'claude-code', NOW);
		const rotated = refresh(database, connection.refreshToken, connection.clientId, NOW + 1000);
		expect(rotated.kind).toBe('issued');
		expect(
			refresh(database, connection.refreshToken, connection.clientId, NOW + 2000)
		).toMatchObject({ error: 'invalid_grant' });
		const grant = database
			.select()
			.from(oauthGrants)
			.where(eq(oauthGrants.id, connection.grantId))
			.get();
		expect(grant?.endedReason).toBe('refresh-reuse');
		if (rotated.kind !== 'issued') throw new Error('not rotated');
		expect(
			authenticateAccessToken(database, rotated.body.access_token, CLIENT, NOW + 3000).kind
		).toBe('invalid');
	});

	it('M9: disabling the person ends their grants at once', async () => {
		const { database, admin, pat } = await setUp();
		const connection = await connectAssistant(database, pat.id, 'claude-code', NOW);
		disableUser(database, admin.id, pat.id, NOW);
		expect(endIneligibleGrants(database, NOW)).toBe(1);
		const grant = database
			.select()
			.from(oauthGrants)
			.where(eq(oauthGrants.id, connection.grantId))
			.get();
		expect(grant?.endedReason).toBe('user-disabled');
		expect(authenticateAccessToken(database, connection.accessToken, CLIENT, NOW).kind).toBe(
			'invalid'
		);
	});

	it('M9: leaving the connect group ends their grants, even before anything sweeps them', async () => {
		const { database, pat, groupId } = await setUp();
		const connection = await connectAssistant(database, pat.id, 'claude-code', NOW);
		database.delete(userGroupMembers).where(eq(userGroupMembers.userGroupId, groupId)).run();
		expect(authenticateAccessToken(database, connection.accessToken, CLIENT, NOW).kind).toBe(
			'invalid'
		);
		const grant = database
			.select()
			.from(oauthGrants)
			.where(eq(oauthGrants.id, connection.grantId))
			.get();
		expect(grant?.endedReason).toBe('not-in-group');
	});

	it('M9: turning MCP off ends every grant', async () => {
		const { database, admin, pat, groupId } = await setUp();
		const connection = await connectAssistant(database, pat.id, 'claude-code', NOW);
		expect(
			saveMcpSettings(database, admin.id, { enabled: false, userGroupId: groupId }, NOW).kind
		).toBe('changed');
		expect(readMcpSettings(database).enabled).toBe(false);
		const grant = database
			.select()
			.from(oauthGrants)
			.where(eq(oauthGrants.id, connection.grantId))
			.get();
		expect(grant?.endedReason).toBe('mcp-off');
	});
});
