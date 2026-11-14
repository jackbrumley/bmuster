import { describe, expect, it } from 'vitest';
import { testDatabase } from '#tests/helpers/fake-agent.ts';
import { connectAssistant, enableMcp } from '#tests/helpers/mcp.ts';
import { addTestUser, NOW } from '#tests/helpers/people.ts';
import { assistantStatus, disconnectGrant, listGrants } from './grants.ts';
import { authenticateAccessToken } from './tokens.ts';

const CLIENT = { ip: '198.51.100.7', userAgent: 'Vitest' };
const MINUTE = 60_000;

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
	const kim = await addTestUser(database, {
		email: 'kim@example.com',
		role: 'member',
		password: null
	});
	enableMcp(database, admin.id, [pat.id, kim.id]);
	return { database, admin, pat, kim };
}

describe('connected assistants (SPEC-MCP M10)', () => {
	it('M10: a person sees their own grants: client, verified or not, connected on, last used and address', async () => {
		const { database, pat, kim } = await setUp();
		const mine = await connectAssistant(database, pat.id, 'claude-code', NOW);
		await connectAssistant(database, kim.id, 'registered', NOW);
		authenticateAccessToken(database, mine.accessToken, CLIENT, NOW + MINUTE);
		expect(listGrants(database, { kind: 'user', userId: pat.id }, NOW + MINUTE)).toEqual([
			{
				id: mine.grantId,
				assistant: { name: 'Claude Code', identity: { kind: 'verified', host: 'claude.ai' } },
				userName: 'pat',
				createdIso: new Date(NOW).toISOString(),
				lastUsed: { kind: 'used', atIso: new Date(NOW + MINUTE).toISOString(), ip: CLIENT.ip },
				active: true
			}
		]);
		expect(listGrants(database, { kind: 'all' }, NOW)).toHaveLength(2);
	});

	it('M10: Disconnect ends the person’s own grant; a member cannot reach another person’s', async () => {
		const { database, pat, kim } = await setUp();
		const patGrant = await connectAssistant(database, pat.id, 'claude-code', NOW);
		const kimGrant = await connectAssistant(database, kim.id, 'claude-code', NOW);
		expect(
			disconnectGrant(database, { userId: pat.id, admin: false }, kimGrant.grantId, NOW)
		).toMatchObject({ kind: 'refused', status: 404 });
		expect(
			disconnectGrant(database, { userId: pat.id, admin: false }, patGrant.grantId, NOW)
		).toEqual({ kind: 'ended' });
		expect(authenticateAccessToken(database, patGrant.accessToken, CLIENT, NOW).kind).toBe(
			'invalid'
		);
		expect(listGrants(database, { kind: 'user', userId: pat.id }, NOW)).toEqual([]);
	});

	it('M10: an admin can disconnect anyone’s grant', async () => {
		const { database, admin, kim } = await setUp();
		const kimGrant = await connectAssistant(database, kim.id, 'registered', NOW);
		expect(
			disconnectGrant(database, { userId: admin.id, admin: true }, kimGrant.grantId, NOW)
		).toEqual({ kind: 'ended' });
		expect(listGrants(database, { kind: 'all' }, NOW)).toEqual([]);
	});

	it('M15: the person’s assistant counts as connected for 10 minutes after its last use', async () => {
		const { database, pat } = await setUp();
		expect(assistantStatus(database, pat.id, NOW)).toEqual({ kind: 'none' });
		const connection = await connectAssistant(database, pat.id, 'registered', NOW);
		authenticateAccessToken(database, connection.accessToken, CLIENT, NOW);
		expect(assistantStatus(database, pat.id, NOW + 9 * MINUTE)).toEqual({
			kind: 'connected',
			name: 'unverified client Helper bot'
		});
		expect(assistantStatus(database, pat.id, NOW + 11 * MINUTE)).toEqual({ kind: 'none' });
	});
});
