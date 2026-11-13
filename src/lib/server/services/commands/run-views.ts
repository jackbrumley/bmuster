import {
	emptyCounts,
	firstLine,
	type CommandScript,
	type RunMachineOutput,
	type RunMachineView,
	type RunSummary,
	type RunView
} from '#lib/domain/commands/commands.ts';
import type { ConsoleUser } from '#lib/domain/users/user.ts';
import { commandScriptSchema } from '#lib/schemas/commands/commands.ts';
import type { Queryable } from '../../database/connection.ts';
import { visibleMachineIds } from '../access/access.ts';
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
				startedBy: run.startedByName,
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

function viewOf(run: RunRow, rows: RunMachineRow[], scripts: CommandScript[], user: ConsoleUser) {
	return {
		id: run.id,
		startedBy: run.startedByName,
		startedIso: run.startedAt.toISOString(),
		endedIso: run.endedAt === null ? null : run.endedAt.toISOString(),
		status: run.status,
		timeoutMs: run.timeoutMs,
		scripts,
		machines: rows.map(machineView),
		counts: countsOf(rows),
		canCancel: run.status === 'running' && mayCancel(user, run.startedBy)
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
	const scripts = scriptsOf(database, [runId]).map(scriptView);
	return viewOf(run, rows, scripts, user);
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
