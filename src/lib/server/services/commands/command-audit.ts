import {
	commandOsLabel,
	commandShellLabel,
	countsLine,
	runMachineStatusLabel,
	type CommandScript,
	type RunCounts,
	type RunMachineStatus
} from '#lib/domain/commands/commands.ts';
import type { Queryable } from '../../database/connection.ts';
import { recordAudit } from '../audit/audit.ts';

/**
 * Audit entries for command runs (SPEC-COMMANDS C19): the start with every command, each
 * machine's result with its output's size and SHA-256 (never the output), a cancel, and the
 * end with its totals.
 */

function seconds(ms: number): string {
	return `${Math.round(ms / 100) / 10} s`;
}

export function auditRunStarted(
	database: Queryable,
	run: {
		id: string;
		userId: string;
		scripts: CommandScript[];
		timeoutMs: number;
		machineCount: number;
		skippedCount: number;
		rerunOf: string | null;
	},
	now: number
): void {
	const commands = Object.fromEntries(
		run.scripts.flatMap((script) => {
			const system = commandOsLabel(script.osFamily);
			return [
				[`${system} command`, script.command],
				[`${system} shell`, commandShellLabel(script.shell)]
			];
		})
	);
	recordAudit(
		database,
		{
			actor: { kind: 'user', userId: run.userId },
			kind: 'command-run-started',
			target: `${run.machineCount} ${run.machineCount === 1 ? 'machine' : 'machines'}`,
			machineId: null,
			detail: {
				run: run.id,
				...commands,
				'time limit': seconds(run.timeoutMs),
				machines: String(run.machineCount),
				skipped: String(run.skippedCount),
				'run as': 'Administrator (root or SYSTEM)',
				...(run.rerunOf === null ? {} : { 'run again from': run.rerunOf })
			}
		},
		now
	);
}

export function auditMachineResult(
	database: Queryable,
	entry: {
		runId: string;
		userId: string;
		machineId: string;
		machineName: string;
		status: RunMachineStatus;
		reason: string | null;
		exitCode: number | null;
		durationMs: number | null;
		outputBytes: number | null;
		outputSha256: string | null;
		sessionId: string | null;
	},
	now: number
): void {
	recordAudit(
		database,
		{
			actor: { kind: 'user', userId: entry.userId },
			kind: 'command-run-machine',
			target: entry.machineName,
			machineId: entry.machineId,
			detail: {
				run: entry.runId,
				result: runMachineStatusLabel(entry.status),
				...(entry.reason === null ? {} : { reason: entry.reason }),
				...(entry.exitCode === null ? {} : { 'exit code': String(entry.exitCode) }),
				...(entry.durationMs === null ? {} : { duration: seconds(entry.durationMs) }),
				...(entry.outputBytes === null ? {} : { 'output bytes': String(entry.outputBytes) }),
				...(entry.outputSha256 === null ? {} : { 'output SHA-256': entry.outputSha256 }),
				...(entry.sessionId === null ? {} : { session: entry.sessionId })
			}
		},
		now
	);
}

export function auditRunCancelled(
	database: Queryable,
	entry: { runId: string; userId: string; notStarted: number },
	now: number
): void {
	recordAudit(
		database,
		{
			actor: { kind: 'user', userId: entry.userId },
			kind: 'command-run-cancelled',
			target: `Run ${entry.runId}`,
			machineId: null,
			detail: { run: entry.runId, 'machines not started': String(entry.notStarted) }
		},
		now
	);
}

export function auditRunEnded(
	database: Queryable,
	entry: { runId: string; startedBy: string; counts: RunCounts; durationMs: number },
	now: number
): void {
	recordAudit(
		database,
		{
			actor: { kind: 'user', userId: entry.startedBy },
			kind: 'command-run-ended',
			target: `Run ${entry.runId}`,
			machineId: null,
			detail: {
				run: entry.runId,
				totals: countsLine(entry.counts),
				duration: seconds(entry.durationMs)
			}
		},
		now
	);
}
