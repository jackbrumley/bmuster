import { afterEach, describe, expect, it } from 'vitest';
import { runCommandInput } from '#lib/schemas/mcp/tools.ts';
import {
	agentAnswers,
	asAsked,
	connect,
	disconnectAgents,
	MINUTE,
	setUpAssistantRuns
} from '#tests/helpers/assistant-runs.ts';
import { listAudit, listAuditOfKinds } from '../audit/audit.ts';
import { runCommandTool } from '../mcp/command-tools.ts';
import { withActorNames } from '../users/activity-feed.ts';
import { expirePendingRuns } from './assistant-pending.ts';
import { approveRun, denyRun } from './assistant-runs.ts';

afterEach(disconnectAgents);

const ask = (command: string) =>
	runCommandInput.parse({
		machines: ['mint'],
		shell: 'bash',
		command,
		reason: 'Check the backup unit'
	});

describe('audit (SPEC-MCP M29, section 12)', () => {
	it('M29: request, approval with its edit, per-machine result and end, all attributed', async () => {
		const { database, relay, machine, people, assistantOf, tools, consoleAs } =
			await setUpAssistantRuns();
		const tickets = connect(machine.mint);
		const pat = await assistantOf('pat');
		const asked = await runCommandTool(tools(pat), ask('systemctl status restic-backup'));
		const runId = asked.kind === 'ok' ? asked.output.runId : '';
		await approveRun(consoleAs('pat'), runId, asAsked('systemctl status restic', 60_000, 1));
		const [ticket] = tickets;
		if (ticket !== undefined)
			agentAnswers(relay, ticket, { stdout: 'ok', stderr: '', exitCode: 0 });

		const entries = withActorNames(database, listAudit(database, 10)).reverse();
		const byKind = (kind: string) => entries.find((entry) => entry.kind === kind);
		const via = `${people.pat.name} via Claude Code`;
		expect(byKind('command-run-requested')).toMatchObject({
			actor: { kind: 'user', name: via },
			target: 'mint'
		});
		expect(byKind('command-run-requested')?.detail).toEqual(
			expect.arrayContaining([
				{ label: 'command', value: 'systemctl status restic-backup' },
				{ label: 'reason', value: 'Check the backup unit' },
				{ label: 'shell', value: 'bash' }
			])
		);
		expect(byKind('command-run-started')).toMatchObject({
			actor: { kind: 'user', name: people.pat.name }
		});
		expect(byKind('command-run-started')?.detail).toEqual(
			expect.arrayContaining([
				{ label: 'asked via', value: 'Claude Code' },
				{ label: 'edited', value: 'yes' },
				{ label: 'requested command', value: 'systemctl status restic-backup' }
			])
		);
		expect(byKind('command-run-machine')).toMatchObject({ actor: { kind: 'user', name: via } });
		expect(byKind('command-run-ended')).toMatchObject({ actor: { kind: 'user', name: via } });
	});

	it('M29: denials and expiries have kinds of their own', async () => {
		const { database, runner, people, assistantOf, tools, consoleAs, clock } =
			await setUpAssistantRuns();
		const pat = await assistantOf('pat');
		const first = await runCommandTool(tools(pat), ask('uptime'));
		const second = await runCommandTool(tools(pat), ask('df -h'));
		denyRun(consoleAs('pat'), first.kind === 'ok' ? first.output.runId : '', 'Not now');
		expirePendingRuns({ database, runner, now: clock.now + 11 * MINUTE });
		const records = listAuditOfKinds(database, {
			kinds: ['command-run-denied', 'command-run-expired'],
			sinceMs: 0,
			limit: 10
		});
		expect(records.map((record) => record.kind).sort()).toEqual([
			'command-run-denied',
			'command-run-expired'
		]);
		expect(records.find((record) => record.kind === 'command-run-denied')).toMatchObject({
			actorUserId: people.pat.id,
			detail: { note: 'Not now', 'asked via': 'Claude Code' }
		});
		expect(records.find((record) => record.kind === 'command-run-expired')).toMatchObject({
			detail: { run: second.kind === 'ok' ? second.output.runId : '', via: 'Claude Code' }
		});
	});
});
