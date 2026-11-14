import {
	emptyCounts,
	firstLine,
	requesterText,
	type RunOrigin,
	type CommandScript,
	type RunMachineOutput,
	type RunMachineView,
	type RunSummary,
	type RunView
} from '#lib/domain/commands/commands.ts';
import type { ConsoleUser } from '#lib/domain/users/user.ts';
import { commandScriptSchema } from '#lib/schemas/commands/commands.ts';
import type { Queryable } from '../../database/connection.ts';
import { assistantLabel } from '#lib/domain/mcp/mcp.ts';
import { visibleMachineIds } from '../access/access.ts';
import { findGrant } from '../oauth/grants.ts';
import { findUserById } from '../users/users.ts';
import {
	findRun,
	machinesOf,
	newestRuns,
	outputOf,
	scriptsOf,
	type RunMachineRow,
	type RunRow
} from './command-runs.ts';
import { mayCancel } from './commands.ts';

/**
 * What the Commands tab and a run's results page show (SPEC-COMMANDS C16, C20). A person sees
 * a run only through the machines they can view: its other machines are left out, and a run
 * with none they can view is not theirs to see. Output is read one machine at a time.
 */

/** Runs listed on the Commands tab. */
const LIST_LIMIT = 200;

/** A stored script, read back through the schema that let it in. */
function scriptView(row: { osFamily: string; shell: string; command: string }): CommandScript {
	return commandScriptSchema.parse({
		osFamily: row.osFamily,
		shell: row.shell,
		command: row.command
	});
}

function machineView(row: RunMachineRow): RunMachineView {
	return {
		machineId: row.machineId,
		machineName: row.machineName,
		status: row.status,
		reason: row.skipReason ?? '',
		exitCode: row.exitCode,
		durationMs: row.durationMs,
		output:
			row.outputDeletedAt !== null
				? { kind: 'deleted' }
				: row.outputKept
					? { kind: 'kept', bytes: row.outputBytes ?? 0 }
					: { kind: 'none' }
	};
}

type ScriptRow = ReturnType<typeof scriptsOf>[number];

/** Who asked for the run, and for an assistant's run what the approver decided (SPEC-MCP M28). */
export function originOf(
	database: Queryable,
	run: RunRow,
	scripts: readonly ScriptRow[]
): RunOrigin {
	if (run.requester === 'person' || run.oauthGrantId === null) {
		return { kind: 'person' };
	}
	const grant = findGrant(database, run.oauthGrantId);
	const decidedBy =
		run.decidedBy === null ? '' : (findUserById(database, run.decidedBy)?.name ?? '');
	const decidedIso = (run.decidedAt ?? run.startedAt).toISOString();
	const script = scripts.find((row) => row.runId === run.id);
	const requestedCommand = script?.requestedCommand ?? null;
	const decision = ((): Extract<RunOrigin, { kind: 'assistant' }>['decision'] => {
		switch (run.status) {
			case 'pending-approval':
				return { kind: 'pending' };
			case 'denied':
				return { kind: 'denied', by: decidedBy, atIso: decidedIso, note: run.denyNote ?? '' };
			case 'expired':
				return { kind: 'expired' };
			case 'running':
			case 'finished':
			case 'cancelled':
				if (run.decidedBy === null) {
					return { kind: 'cancelled' };
				}
				return {
					kind: 'approved',
					by: decidedBy,
					atIso: decidedIso,
					edit:
						requestedCommand === null && run.requestedTimeoutMs === null
							? { kind: 'unchanged' }
							: {
									kind: 'edited',
									requestedCommand: requestedCommand ?? script?.command ?? '',
									requestedTimeoutMs: run.requestedTimeoutMs ?? run.timeoutMs
								}
				};
		}
	})();
	return {
		kind: 'assistant',
		assistant: grant === undefined ? 'an AI assistant' : assistantLabel(grant.assistant),
		verified: grant?.assistant.identity.kind === 'verified',
		reason: run.reason ?? '',
		expiresIso: (run.expiresAt ?? run.startedAt).toISOString(),
		decision
	};
}

function countsOf(rows: readonly RunMachineRow[]) {
	const counts = emptyCounts();
	for (const row of rows) {
		counts[row.status] += 1;
	}
	return counts;
}

/** The newest runs with at least one machine the person can view. */
export function listRunsFor(database: Queryable, user: ConsoleUser): RunSummary[] {
	const visible = visibleMachineIds(database, user);
	const runs = newestRuns(database, LIST_LIMIT);
	const ids = runs.map((run) => run.id);
	const machines = machinesOf(database, ids).filter((row) => visible.has(row.machineId));
	const scripts = scriptsOf(database, ids);
	return runs.flatMap((run): RunSummary[] => {
		const own = machines.filter((row) => row.runId === run.id);
		if (own.length === 0) {
			return [];
		}
		return [
			{
				id: run.id,
				startedBy: requesterText(
					run.startedByName,
					originOf(
						database,
						run,
						scripts.filter((script) => script.runId === run.id)
					)
				),
				startedIso: run.startedAt.toISOString(),
				status: run.status,
				commands: scripts
					.filter((script) => script.runId === run.id)
					.map((script) => ({ osFamily: script.osFamily, firstLine: firstLine(script.command) })),
				counts: countsOf(own)
			}
		];
	});
}

function viewOf(
	run: RunRow,
	origin: RunOrigin,
	rows: RunMachineRow[],
	scripts: CommandScript[],
	user: ConsoleUser
) {
	return {
		id: run.id,
		startedBy: requesterText(run.startedByName, origin),
		origin,
		startedIso: run.startedAt.toISOString(),
		endedIso: run.endedAt === null ? null : run.endedAt.toISOString(),
		status: run.status,
		timeoutMs: run.timeoutMs,
		scripts,
		machines: rows.map(machineView),
		counts: countsOf(rows),
		canCancel:
			(run.status === 'running' || run.status === 'pending-approval') &&
			mayCancel(user, run.startedBy)
	} satisfies RunView;
}

/** One run as the person may see it, or undefined (404) when they can view none of its machines. */
export function runViewFor(
	database: Queryable,
	user: ConsoleUser,
	runId: string
): RunView | undefined {
	const run = findRun(database, runId);
	if (run === undefined) {
		return undefined;
	}
	const visible = visibleMachineIds(database, user);
	const rows = machinesOf(database, [runId]).filter((row) => visible.has(row.machineId));
	if (rows.length === 0) {
		return undefined;
	}
	const scriptRows = scriptsOf(database, [runId]);
	return viewOf(run, originOf(database, run, scriptRows), rows, scriptRows.map(scriptView), user);
}

/** One machine's output, for a person who can view the machine; undefined otherwise. */
export function runOutputFor(
	database: Queryable,
	user: ConsoleUser,
	runId: string,
	machineId: string
): RunMachineOutput | undefined {
	if (!visibleMachineIds(database, user).has(machineId)) {
		return undefined;
	}
	const row = outputOf(database, runId, machineId);
	if (row === undefined) {
		return undefined;
	}
	if (row.outputDeletedAt !== null) {
		return { kind: 'deleted' };
	}
	if (row.stdout === null || row.stderr === null) {
		return { kind: 'none' };
	}
	return {
		kind: 'kept',
		stdout: row.stdout,
		stderr: row.stderr,
		stdoutTruncated: row.stdoutTruncated,
		stderrTruncated: row.stderrTruncated
	};
}
