import { describe, expect, it } from 'vitest';
import { testDatabase } from '#tests/helpers/fake-agent.ts';
import { connectAssistant, enableMcp } from '#tests/helpers/mcp.ts';
import { addTestUser, NOW } from '#tests/helpers/people.ts';
import { oauthGrants } from '../../database/schema.ts';
import { listAudit } from '../audit/audit.ts';
import { stopAllAiAccess } from './grants.ts';
import { mcpEnabled } from './mcp-settings.ts';
import { authenticateAccessToken } from './tokens.ts';

describe('Stop all AI access (SPEC-MCP M14)', () => {
	it('M14: turns MCP off and ends every grant and token, audited', async () => {
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
		enableMcp(database, admin.id, [pat.id, admin.id]);
		const first = await connectAssistant(database, pat.id, 'claude-code', NOW);
		const second = await connectAssistant(database, admin.id, 'registered', NOW);
		expect(stopAllAiAccess(database, admin.id, NOW + 1000)).toBe(2);
		expect(mcpEnabled(database)).toBe(false);
		expect(
			database
				.select()
				.from(oauthGrants)
				.all()
				.map((grant) => grant.endedReason)
		).toEqual(['kill-switch', 'kill-switch']);
		for (const token of [first.accessToken, second.accessToken]) {
			expect(
				authenticateAccessToken(database, token, { ip: '::1', userAgent: '' }, NOW + 2000).kind
			).toBe('invalid');
		}
		expect(listAudit(database, 10)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: 'mcp-kill-switch',
					actorUserId: admin.id,
					detail: { grantsEnded: '2' }
				}),
				expect.objectContaining({ kind: 'setting-changed', target: 'Allow AI assistants (MCP)' })
			])
		);
	});
});
