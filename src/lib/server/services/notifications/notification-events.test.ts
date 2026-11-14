import { afterEach, describe, expect, it } from 'vitest';
import { NOTIFICATION_CATALOGUE } from '#lib/domain/notifications/notifications.ts';
import { runCommandInput } from '#lib/schemas/mcp/tools.ts';
import { done } from '#tests/helpers/access.ts';
import { disconnectAgents, setUpAssistantRuns } from '#tests/helpers/assistant-runs.ts';
import { setUpEmail } from '#tests/helpers/email.ts';
import { emailMessages } from '../../database/schema.ts';
import { runCommandTool } from '../mcp/command-tools.ts';
import { createRule } from './notification-rules.ts';
import { processNotificationEvents } from './notify.ts';

afterEach(disconnectAgents);

describe('AI command waiting for approval (SPEC-MCP M27)', () => {
	it('M27: names the machines, the person, the assistant and the first line, and links to the run', async () => {
		const { database, people, assistantOf, tools, clock } = await setUpAssistantRuns();
		setUpEmail(database, people.admin.id, 2525);
		done(
			createRule(
				database,
				people.admin.id,
				{
					eventKind: 'command-approval-requested',
					scope: { kind: 'any-machine' },
					recipients: { kind: 'addresses', addresses: ['approvers@example.test'] },
					enabled: true
				},
				clock.now
			)
		);
		const pat = await assistantOf('pat');
		const asked = await runCommandTool(
			tools(pat),
			runCommandInput.parse({
				machines: ['mint', 'reception'],
				shell: 'bash',
				command: 'systemctl status restic-backup\njournalctl -u restic-backup',
				reason: 'Backups'
			})
		);
		const runId = asked.kind === 'ok' ? asked.output.runId : '';
		expect(processNotificationEvents(database, clock.now)).toBe(1);
		const [message] = database.select().from(emailMessages).all();
		expect(message).toMatchObject({
			toAddress: 'approvers@example.test',
			subject: 'Approval needed: a command on mint and reception'
		});
		expect(message?.body).toContain(`${people.pat.name} via Claude Code`);
		expect(message?.body).toContain('systemctl status restic-backup');
		expect(message?.body).not.toContain('journalctl');
		expect(message?.body).toContain(`/commands/${runId}`);
		// The email never approves: it only links to the console.
		expect(message?.body).not.toContain('/approve');
		expect(NOTIFICATION_CATALOGUE['command-approval-requested'].label).toBe(
			'AI command waiting for approval'
		);
	});
});
