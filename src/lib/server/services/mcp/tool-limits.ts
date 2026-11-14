import { ASSISTANT_RUN_LIMITS } from '#lib/domain/commands/assistant-runs.ts';

/**
 * Rate limits on an assistant's tool calls (SPEC-MCP M24), per person: 600 tool calls an hour,
 * and of those 60 `run_command` calls. Counted in memory, like the registration limit: a restart
 * forgets them. (The 5 pending requests are counted from the database, in assistant-runs.ts.)
 */

const HOUR_MS = 60 * 60_000;

export type ToolLimits = {
	/** Counts a call and says whether it may go ahead, or why not. */
	take(
		userId: string,
		tool: string,
		now: number
	): { kind: 'allowed' } | { kind: 'refused'; message: string };
};

export function createToolLimits(): ToolLimits {
	const calls = new Map<string, number[]>();
	const runs = new Map<string, number[]>();

	function recent(map: Map<string, number[]>, userId: string, now: number): number[] {
		const kept = (map.get(userId) ?? []).filter((at) => now - at < HOUR_MS);
		map.set(userId, kept);
		return kept;
	}

	return {
		take(userId, tool, now) {
			const toolCalls = recent(calls, userId, now);
			if (toolCalls.length >= ASSISTANT_RUN_LIMITS.toolCallsPerHour) {
				return {
					kind: 'refused',
					message: `Too many tool calls: at most ${String(ASSISTANT_RUN_LIMITS.toolCallsPerHour)} an hour. Wait a while before calling again.`
				};
			}
			if (tool === 'run_command') {
				const runCalls = recent(runs, userId, now);
				if (runCalls.length >= ASSISTANT_RUN_LIMITS.runCommandPerHour) {
					return {
						kind: 'refused',
						message: `Too many commands asked for: at most ${String(ASSISTANT_RUN_LIMITS.runCommandPerHour)} an hour. Wait a while before asking again.`
					};
				}
				runCalls.push(now);
			}
			toolCalls.push(now);
			return { kind: 'allowed' };
		}
	};
}

/** The server's limits, one set for every request. */
export const serverToolLimits: ToolLimits = createToolLimits();
