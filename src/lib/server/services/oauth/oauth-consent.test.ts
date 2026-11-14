import { describe, expect, it } from 'vitest';
import {
	CLAUDE_CODE_DOCUMENT,
	CLAUDE_CODE_ID,
	documentServer,
	mcpPeople,
	ORIGIN,
	pkcePair,
	RESOURCE
} from '#tests/helpers/mcp.ts';
import { NOW } from '#tests/helpers/people.ts';
import { oauthGrants } from '../../database/schema.ts';
import { listAudit } from '../audit/audit.ts';
import { disableUser } from '../users/users.ts';
import { consentView, decideConsent } from './authorize.ts';

const server = documentServer({ [CLAUDE_CODE_ID]: CLAUDE_CODE_DOCUMENT });

function request() {
	return {
		response_type: 'code',
		client_id: CLAUDE_CODE_ID,
		redirect_uri: 'http://localhost:4567/callback',
		code_challenge: pkcePair().challenge,
		code_challenge_method: 'S256',
		state: 'xyz',
		resource: RESOURCE
	};
}

const setUp = mcpPeople;

describe('who may connect (SPEC-MCP M2)', () => {
	it('M2: a member of the connect group is asked', async () => {
		const { database, pat } = await setUp();
		expect(
			await consentView(database, pat.id, request(), ORIGIN, server.fetchJson, NOW)
		).toMatchObject({
			kind: 'ask',
			assistant: { name: 'Claude Code' },
			redirect: { kind: 'loopback' },
			scopes: ['machines:read', 'commands:run']
		});
	});

	it('M2: admins are not exempt: outside the group, the screen says no and Allow is refused', async () => {
		const { database, admin } = await setUp();
		expect(
			await consentView(database, admin.id, request(), ORIGIN, server.fetchJson, NOW)
		).toMatchObject({
			kind: 'not-allowed'
		});
		const decision = await decideConsent(
			database,
			{ userId: admin.id, allow: true, params: request() },
			ORIGIN,
			server.fetchJson,
			NOW
		);
		expect(decision.kind).toBe('not-allowed');
		expect(database.select().from(oauthGrants).all()).toEqual([]);
		expect(listAudit(database, 5)[0]).toMatchObject({
			kind: 'mcp-client-refused',
			actorUserId: admin.id,
			detail: { reason: 'not-allowed', assistant: 'Claude Code' }
		});
	});

	it('M2: a disabled member of the group may not allow a client', async () => {
		const { database, admin, kim } = await setUp();
		disableUser(database, admin.id, kim.id, NOW);
		const decision = await decideConsent(
			database,
			{ userId: kim.id, allow: true, params: request() },
			ORIGIN,
			server.fetchJson,
			NOW
		);
		expect(decision.kind).toBe('not-allowed');
	});

	it('M2: Allow returns a code with state and iss; Cancel returns access_denied, both audited', async () => {
		const { database, pat } = await setUp();
		const allowed = await decideConsent(
			database,
			{ userId: pat.id, allow: true, params: request() },
			ORIGIN,
			server.fetchJson,
			NOW
		);
		if (allowed.kind !== 'redirect') throw new Error(allowed.kind);
		const back = new URL(allowed.location);
		expect(back.origin).toBe('http://localhost:4567');
		expect(back.searchParams.get('code')?.startsWith('bmac_')).toBe(true);
		expect(back.searchParams.get('state')).toBe('xyz');
		expect(back.searchParams.get('iss')).toBe(ORIGIN);
		const cancelled = await decideConsent(
			database,
			{ userId: pat.id, allow: false, params: request() },
			ORIGIN,
			server.fetchJson,
			NOW
		);
		if (cancelled.kind !== 'redirect') throw new Error(cancelled.kind);
		expect(new URL(cancelled.location).searchParams.get('error')).toBe('access_denied');
		expect(listAudit(database, 10).map((entry) => entry.kind)).toEqual(
			expect.arrayContaining(['mcp-client-allowed', 'mcp-client-refused'])
		);
	});
});
