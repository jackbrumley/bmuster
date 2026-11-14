import { afterEach, describe, expect, it } from 'vitest';
import { runCommandInput } from '#lib/schemas/mcp/tools.ts';
import { disconnectAgents, setUpAssistantRuns } from '#tests/helpers/assistant-runs.ts';
import { NOW } from '#tests/helpers/people.ts';
import { runCommandTool } from './command-tools.ts';
import { createToolLimits } from './tool-limits.ts';

afterEach(disconnectAgents);

const HOUR = 60 * 60_000;

describe('rate limits (SPEC-MCP M24)', () => {
	it('M24: at most 5 requests waiting per person; the sixth is a tool error', async () => {
		const { assistantOf, tools } = await setUpAssistantRuns();
		const pat = await assistantOf('pat');
		const ask = runCommandInput.parse({
			machines: ['mint'],
			shell: 'bash',
			command: 'uptime',
			reason: 'Load'
		});
		for (let index = 0; index < 5; index += 1) {
			expect((await runCommandTool(tools(pat), ask)).kind).toBe('ok');
		}
		expect(await runCommandTool(tools(pat), ask)).toEqual({
			kind: 'error',
			message:
				'5 requests already wait for approval. Wait for a decision, or withdraw one with cancel_command.'
		});
	});

	it('M24: 60 run_command calls and 600 tool calls an hour, per person', () => {
		const limits = createToolLimits();
		for (let index = 0; index < 60; index += 1) {
			expect(limits.take('pat', 'run_command', NOW)).toEqual({ kind: 'allowed' });
		}
		expect(limits.take('pat', 'run_command', NOW)).toMatchObject({ kind: 'refused' });
		expect(limits.take('kim', 'run_command', NOW)).toEqual({ kind: 'allowed' });
		for (let index = 0; index < 540; index += 1) {
			expect(limits.take('pat', 'list_machines', NOW)).toEqual({ kind: 'allowed' });
		}
		expect(limits.take('pat', 'get_machine', NOW)).toEqual({
			kind: 'refused',
			message: 'Too many tool calls: at most 600 an hour. Wait a while before calling again.'
		});
		expect(limits.take('pat', 'run_command', NOW + HOUR)).toEqual({ kind: 'allowed' });
	});
});
