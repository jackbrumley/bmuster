import {
	commandOsLabel,
	commandShellLabel,
	countsLine,
	runMachineStatusLabel,
	type CommandScript,
	type CommandShell,
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
		/** An assistant's run approved by a person (SPEC-MCP 12): who asked, through what, any edit. */
		approval: ApprovalDetail;
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
				...(run.rerunOf === null ? {} : { 'run again from': run.rerunOf }),
				...approvalDetail(run.approval)
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
		/** "via" the assistant for an assistant's run (SPEC-MCP 12); empty otherwise. */
		via: Record<string, string>;
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
				...(entry.sessionId === null ? {} : { session: entry.sessionId }),
				...entry.via
			}
		},
		now
	);
}

/** Who cancelled a run (SPEC-MCP 12): a person, the assistant, a disconnect or the kill switch. */
export type CancelledBy = 'person' | 'assistant' | 'disconnect' | 'kill-switch';

export function auditRunCancelled(
	database: Queryable,
	entry: {
		runId: string;
		userId: string;
		notStarted: number;
		by: CancelledBy;
		/** "via" the assistant when the assistant withdrew it; empty otherwise. */
		via: Record<string, string>;
	},
	now: number
): void {
	recordAudit(
		database,
		{
			actor: { kind: 'user', userId: entry.userId },
			kind: 'command-run-cancelled',
			target: `Run ${entry.runId}`,
			machineId: null,
			detail: {
				run: entry.runId,
				'machines not started': String(entry.notStarted),
				...(entry.by === 'person' ? {} : { by: entry.by }),
				...entry.via
			}
		},
		now
	);
}

/** An approved assistant's run, for the start entry; `none` for a person's own run. */
export type ApprovalDetail =
	| { kind: 'none' }
	| {
			kind: 'approved';
			requestedBy: string;
			assistant: string;
			edit: { kind: 'unchanged' } | { kind: 'edited'; requestedCommand: string };
	  };

function approvalDetail(approval: ApprovalDetail): Record<string, string> {
	switch (approval.kind) {
		case 'none':
			return {};
		case 'approved':
			return {
				'requested by': approval.requestedBy,
				'asked via': approval.assistant,
				edited: approval.edit.kind === 'edited' ? 'yes' : 'no',
				...(approval.edit.kind === 'edited'
					? { 'requested command': approval.edit.requestedCommand }
					: {})
			};
	}
}

/** "mint", or "3 machines": the target of a request's entries. */
function machinesTarget(names: readonly string[]): string {
	return names.length === 1 ? (names[0] ?? '') : `${String(names.length)} machines`;
}

/**
 * `run_command` (SPEC-MCP 12): the person as actor, the assistant as `via`, and everything the
 * approver will see: machines, shell, command, time limit and reason.
 */
export function auditRunRequested(
	database: Queryable,
	entry: {
		runId: string;
		userId: string;
		via: Record<string, string>;
		machines: { id: string; name: string }[];
		shell: CommandShell;
		command: string;
		timeoutMs: number;
		reason: string;
	},
	now: number
): void {
	const names = entry.machines.map((machine) => machine.name);
	recordAudit(
		database,
		{
			actor: { kind: 'user', userId: entry.userId },
			kind: 'command-run-requested',
			target: machinesTarget(names),
			machineId: entry.machines.length === 1 ? (entry.machines[0]?.id ?? null) : null,
			detail: {
				run: entry.runId,
				machines: names.join(', '),
				shell: commandShellLabel(entry.shell),
				command: entry.command,
				'time limit': seconds(entry.timeoutMs),
				reason: entry.reason,
				...entry.via
			}
		},
		now
	);
}

export function auditRunDenied(
	database: Queryable,
	entry: {
		runId: string;
		approverId: string;
		requestedBy: string;
		assistant: string;
		machineNames: string[];
		note: string;
	},
	now: number
): void {
	recordAudit(
		database,
		{
			actor: { kind: 'user', userId: entry.approverId },
			kind: 'command-run-denied',
			target: machinesTarget(entry.machineNames),
			machineId: null,
			detail: {
				run: entry.runId,
				'requested by': entry.requestedBy,
				'asked via': entry.assistant,
				...(entry.note === '' ? {} : { note: entry.note })
			}
		},
		now
	);
}

export function auditRunExpired(
	database: Queryable,
	entry: { runId: string; userId: string; machineNames: string[]; via: Record<string, string> },
	now: number
): void {
	recordAudit(
		database,
		{
			actor: { kind: 'user', userId: entry.userId },
			kind: 'command-run-expired',
			target: machinesTarget(entry.machineNames),
			machineId: null,
			detail: { run: entry.runId, ...entry.via }
		},
		now
	);
}

export function auditRunEnded(
	database: Queryable,
	entry: {
		runId: string;
		startedBy: string;
		counts: RunCounts;
		durationMs: number;
		via: Record<string, string>;
	},
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
				duration: seconds(entry.durationMs),
				...entry.via
			}
		},
		now
	);
}
