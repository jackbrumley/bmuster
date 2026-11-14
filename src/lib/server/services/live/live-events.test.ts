import { afterEach, describe, expect, it } from 'vitest';
import { liveEventSchema, LIVE_EVENT } from '#lib/schemas/commands/approvals.ts';
import { runCommandInput } from '#lib/schemas/mcp/tools.ts';
import { disconnectAgents, setUpAssistantRuns } from '#tests/helpers/assistant-runs.ts';
import { startSession } from '../auth/sessions.ts';
import { denyRun } from '../commands/assistant-runs.ts';
import { approvalsNav } from '../commands/approvers.ts';
import { runCommandTool } from '../mcp/command-tools.ts';
import { liveStream } from './live-events.ts';

afterEach(disconnectAgents);

/** Reads a live stream's events as they come, parsed. */
function listen(stream: ReadableStream<Uint8Array>) {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	const events: unknown[] = [];
	let buffer = '';
	const pump = async (): Promise<void> => {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) return;
			buffer += decoder.decode(value);
			const blocks = buffer.split('\n\n');
			buffer = blocks.pop() ?? '';
			for (const block of blocks) {
				const data = block.split('\n').find((line) => line.startsWith('data: '));
				if (block.includes(`event: ${LIVE_EVENT}`) && data !== undefined) {
					events.push(liveEventSchema.parse(JSON.parse(data.slice('data: '.length))));
				}
			}
		}
	};
	void pump();
	return {
		events,
		stop: () => {
			void reader.cancel();
		}
	};
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('the live channel (SPEC-MCP M26)', () => {
	it('M26: a request reaches every open tab of a person who may decide it, and nobody else', async () => {
		const { database, people, consoleAs, assistantOf, tools, clock } = await setUpAssistantRuns();
		const patTab = listen(liveStream(database, consoleAs('pat').sessionToken, () => clock.now));
		const secondTab = listen(
			liveStream(
				database,
				startSession(database, people.pat.id, { ip: '192.0.2.4', userAgent: 'Phone' }, clock.now)
					.token,
				() => clock.now
			)
		);
		const kimTab = listen(liveStream(database, consoleAs('kim').sessionToken, () => clock.now));
		const pat = await assistantOf('pat');
		const asked = await runCommandTool(
			tools(pat),
			runCommandInput.parse({
				machines: ['mint'],
				shell: 'bash',
				command: 'uptime',
				reason: 'Load'
			})
		);
		const runId = asked.kind === 'ok' ? asked.output.runId : '';
		await settle();
		for (const tab of [patTab, secondTab]) {
			expect(tab.events).toEqual([
				{
					kind: 'approval-requested',
					pending: 1,
					approval: expect.objectContaining({
						runId,
						machineNames: ['mint'],
						firstLine: 'uptime',
						assistant: 'Claude Code'
					}) as unknown
				}
			]);
		}
		expect(kimTab.events).toEqual([]);
		denyRun(consoleAs('pat'), runId, '');
		await settle();
		expect(patTab.events.at(-1)).toEqual({ kind: 'approval-decided', runId, pending: 0 });
		for (const tab of [patTab, secondTab, kimTab]) tab.stop();
	});

	it('M26: Approvals shows in the navigation, with its count, only to people who may approve', async () => {
		const { database, people, assistantOf, tools } = await setUpAssistantRuns();
		expect(approvalsNav(database, people.pat)).toEqual({ kind: 'shown', pending: 0 });
		// Kim may ask but holds Run commands nowhere: she cannot approve, so no Approvals.
		expect(approvalsNav(database, people.kim)).toEqual({ kind: 'hidden' });
		const pat = await assistantOf('pat');
		await runCommandTool(
			tools(pat),
			runCommandInput.parse({
				machines: ['mint'],
				shell: 'bash',
				command: 'uptime',
				reason: 'Load'
			})
		);
		expect(approvalsNav(database, people.pat)).toEqual({ kind: 'shown', pending: 1 });
	});
});
