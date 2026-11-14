import { afterEach, describe, expect, it } from 'vitest';
import { runCommandInput } from '#lib/schemas/mcp/tools.ts';
import {
	asAsked,
	connect,
	disconnectAgents,
	setUpAssistantRuns
} from '#tests/helpers/assistant-runs.ts';
import { testDatabase } from '#tests/helpers/fake-agent.ts';
import { connectAssistant, enableMcp } from '#tests/helpers/mcp.ts';
import { addTestUser, NOW } from '#tests/helpers/people.ts';
import { oauthGrants } from '../../database/schema.ts';
import { listAudit } from '../audit/audit.ts';
import { settleEndedGrantRuns } from '../commands/assistant-pending.ts';
import { approveRun } from '../commands/assistant-runs.ts';
import { findRun } from '../commands/command-runs.ts';
import { runCommandTool } from '../mcp/command-tools.ts';
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

describe('Stop all AI access ends assistant runs too (SPEC-MCP M29)', () => {
	afterEach(disconnectAgents);

	it('M29: every pending request is cancelled, and running ones lose their machines not started', async () => {
		const { database, runner, people, machine, assistantOf, tools, consoleAs, clock } =
			await setUpAssistantRuns();
		const pat = await assistantOf('pat');
		const ask = (machines: string[]) =>
			runCommandInput.parse({ machines, shell: 'bash', command: 'uptime', reason: 'Load' });
		const pending = await runCommandTool(tools(pat), ask(['mint']));
		const started = await runCommandTool(tools(pat), ask(['reception']));
		const pendingId = pending.kind === 'ok' ? pending.output.runId : '';
		const startedId = started.kind === 'ok' ? started.output.runId : '';
		connect(machine.reception);
		await approveRun(consoleAs('pat'), startedId, asAsked('uptime', 60_000, 1));
		stopAllAiAccess(database, people.admin.id, clock.now);
		expect(settleEndedGrantRuns({ database, runner, now: clock.now })).toBe(2);
		expect(findRun(database, pendingId)?.status).toBe('cancelled');
		expect(findRun(database, startedId)?.status).toBe('cancelled');
		expect(listAudit(database, 5)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: 'command-run-cancelled',
					detail: expect.objectContaining({ by: 'kill-switch', run: pendingId }) as unknown
				})
			])
		);
	});
});
