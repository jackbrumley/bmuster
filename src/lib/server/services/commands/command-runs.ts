import { and, asc, desc, eq, inArray, isNull, lt, lte, ne, or, isNotNull } from 'drizzle-orm';
import type { CommandScript, RunMachineStatus, RunStatus } from '#lib/domain/commands/commands.ts';
import type { OsFamily } from '#lib/domain/machines/machine.ts';
import type { Queryable } from '../../database/connection.ts';
import {
	commandRunMachines,
	commandRunScripts,
	commandRuns,
	machines,
	users
} from '../../database/schema.ts';

/**
 * Command runs in the database (SPEC-COMMANDS 4): the run, its command per system, and one row
 * per machine. The only code that touches these tables.
 */

/** A person's run starts at once; an assistant's waits for a person's approval (SPEC-MCP M17). */
export type NewRunOrigin =
	{ kind: 'person' } | { kind: 'assistant'; grantId: string; reason: string; expiresAt: number };

export type NewRun = {
	id: string;
	startedBy: string;
	startedAt: number;
	timeoutMs: number;
	rerunOf: string | null;
	origin: NewRunOrigin;
	scripts: CommandScript[];
	machines: { machineId: string; status: 'waiting' | 'skipped'; skipReason: string | null }[];
};

export function insertRun(database: Queryable, run: NewRun): void {
	database
		.insert(commandRuns)
		.values({
			id: run.id,
			startedBy: run.startedBy,
			startedAt: new Date(run.startedAt),
			endedAt: null,
			status: run.origin.kind === 'person' ? 'running' : 'pending-approval',
			timeoutMs: run.timeoutMs,
			rerunOf: run.rerunOf,
			requester: run.origin.kind,
			...(run.origin.kind === 'assistant'
				? {
						oauthGrantId: run.origin.grantId,
						reason: run.origin.reason,
						expiresAt: new Date(run.origin.expiresAt)
					}
				: {})
		})
		.run();
	database
		.insert(commandRunScripts)
		.values(run.scripts.map((script) => ({ runId: run.id, ...script })))
		.run();
	database
		.insert(commandRunMachines)
		.values(
			run.machines.map((machine, position) => ({
				runId: run.id,
				machineId: machine.machineId,
				position,
				status: machine.status,
				skipReason: machine.skipReason,
				endedAt: machine.status === 'skipped' ? new Date(run.startedAt) : null
			}))
		)
		.run();
}

export type RunRow = typeof commandRuns.$inferSelect & { startedByName: string };

export function findRun(database: Queryable, runId: string): RunRow | undefined {
	const row = database
		.select({ run: commandRuns, name: users.name })
		.from(commandRuns)
		.innerJoin(users, eq(users.id, commandRuns.startedBy))
		.where(eq(commandRuns.id, runId))
		.get();
	return row === undefined ? undefined : { ...row.run, startedByName: row.name };
}

/** The newest runs first. */
export function newestRuns(database: Queryable, limit: number): RunRow[] {
	return database
		.select({ run: commandRuns, name: users.name })
		.from(commandRuns)
		.innerJoin(users, eq(users.id, commandRuns.startedBy))
		.orderBy(desc(commandRuns.startedAt))
		.limit(limit)
		.all()
		.map((row) => ({ ...row.run, startedByName: row.name }));
}

export function scriptsOf(database: Queryable, runIds: readonly string[]) {
	if (runIds.length === 0) {
		return [];
	}
	return database
		.select()
		.from(commandRunScripts)
		.where(inArray(commandRunScripts.runId, [...runIds]))
		.orderBy(asc(commandRunScripts.osFamily))
		.all();
}

export type RunMachineRow = Omit<typeof commandRunMachines.$inferSelect, 'stdout' | 'stderr'> & {
	machineName: string;
	osFamily: OsFamily;
	agentVersion: string;
	outputKept: boolean;
};

/** A run's machines in their order, without their output. */
export function machinesOf(database: Queryable, runIds: readonly string[]): RunMachineRow[] {
	if (runIds.length === 0) {
		return [];
	}
	return database
		.select({
			runId: commandRunMachines.runId,
			machineId: commandRunMachines.machineId,
			position: commandRunMachines.position,
			status: commandRunMachines.status,
			skipReason: commandRunMachines.skipReason,
			sessionId: commandRunMachines.sessionId,
			exitCode: commandRunMachines.exitCode,
			startedAt: commandRunMachines.startedAt,
			endedAt: commandRunMachines.endedAt,
			durationMs: commandRunMachines.durationMs,
			stdoutTruncated: commandRunMachines.stdoutTruncated,
			stderrTruncated: commandRunMachines.stderrTruncated,
			outputBytes: commandRunMachines.outputBytes,
			outputSha256: commandRunMachines.outputSha256,
			outputDeletedAt: commandRunMachines.outputDeletedAt,
			outputKept: isNotNull(commandRunMachines.stdout),
			machineName: machines.name,
			osFamily: machines.osFamily,
			agentVersion: machines.agentVersion
		})
		.from(commandRunMachines)
		.innerJoin(machines, eq(machines.id, commandRunMachines.machineId))
		.where(inArray(commandRunMachines.runId, [...runIds]))
		.orderBy(asc(commandRunMachines.position))
		.all()
		.map((row) => ({ ...row, outputKept: Boolean(row.outputKept) }));
}

export function outputOf(database: Queryable, runId: string, machineId: string) {
	return database
		.select({
			stdout: commandRunMachines.stdout,
			stderr: commandRunMachines.stderr,
			stdoutTruncated: commandRunMachines.stdoutTruncated,
			stderrTruncated: commandRunMachines.stderrTruncated,
			outputDeletedAt: commandRunMachines.outputDeletedAt
		})
		.from(commandRunMachines)
		.where(and(eq(commandRunMachines.runId, runId), eq(commandRunMachines.machineId, machineId)))
		.get();
}

function machineRow(runId: string, machineId: string) {
	return and(eq(commandRunMachines.runId, runId), eq(commandRunMachines.machineId, machineId));
}

/** The machines still waiting their turn, in order. */
export function waitingMachines(database: Queryable, runId: string): string[] {
	return database
		.select({ machineId: commandRunMachines.machineId })
		.from(commandRunMachines)
		.where(and(eq(commandRunMachines.runId, runId), eq(commandRunMachines.status, 'waiting')))
		.orderBy(asc(commandRunMachines.position))
		.all()
		.map((row) => row.machineId);
}

export function markRunning(
	database: Queryable,
	runId: string,
	machineId: string,
	sessionId: string,
	now: number
): void {
	database
		.update(commandRunMachines)
		.set({ status: 'running', sessionId, startedAt: new Date(now) })
		.where(machineRow(runId, machineId))
		.run();
}

/** A machine that never ran: offline, skipped or cancelled. */
export function markNotRun(
	database: Queryable,
	runId: string,
	machineId: string,
	status: Extract<RunMachineStatus, 'offline' | 'skipped' | 'cancelled'>,
	reason: string | null,
	now: number
): void {
	database
		.update(commandRunMachines)
		.set({ status, skipReason: reason, endedAt: new Date(now) })
		.where(machineRow(runId, machineId))
		.run();
}

export type MachineResult = {
	status: Extract<RunMachineStatus, 'succeeded' | 'failed' | 'timed-out' | 'lost'>;
	reason: string | null;
	exitCode: number | null;
	durationMs: number;
	stdout: string;
	stderr: string;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	outputBytes: number;
	outputSha256: string;
};

export function finishMachine(
	database: Queryable,
	runId: string,
	machineId: string,
	result: MachineResult,
	now: number
): void {
	database
		.update(commandRunMachines)
		.set({
			status: result.status,
			skipReason: result.reason,
			exitCode: result.exitCode,
			durationMs: result.durationMs,
			endedAt: new Date(now),
			stdout: result.stdout,
			stderr: result.stderr,
			stdoutTruncated: result.stdoutTruncated,
			stderrTruncated: result.stderrTruncated,
			outputBytes: result.outputBytes,
			outputSha256: result.outputSha256
		})
		.where(machineRow(runId, machineId))
		.run();
}

/** Waiting machines become cancelled (C17); how many. */
export function cancelWaiting(database: Queryable, runId: string, now: number): number {
	return database
		.update(commandRunMachines)
		.set({ status: 'cancelled', endedAt: new Date(now) })
		.where(and(eq(commandRunMachines.runId, runId), eq(commandRunMachines.status, 'waiting')))
		.run().changes;
}

export function endRun(
	database: Queryable,
	runId: string,
	status: Exclude<RunStatus, 'running'>,
	now: number
): void {
	database
		.update(commandRuns)
		.set({ status, endedAt: new Date(now) })
		.where(and(eq(commandRuns.id, runId), isNull(commandRuns.endedAt)))
		.run();
}

export function setRunStatus(database: Queryable, runId: string, status: RunStatus): void {
	database.update(commandRuns).set({ status }).where(eq(commandRuns.id, runId)).run();
}

/** Runs the server was running when it stopped. Runs waiting for approval are not running. */
export function unfinishedRunIds(database: Queryable): string[] {
	return database
		.select({ id: commandRuns.id })
		.from(commandRuns)
		.where(and(isNull(commandRuns.endedAt), ne(commandRuns.status, 'pending-approval')))
		.all()
		.map((row) => row.id);
}

/** Assistant runs waiting for approval, newest first. */
export function pendingRuns(database: Queryable): RunRow[] {
	return database
		.select({ run: commandRuns, name: users.name })
		.from(commandRuns)
		.innerJoin(users, eq(users.id, commandRuns.startedBy))
		.where(eq(commandRuns.status, 'pending-approval'))
		.orderBy(desc(commandRuns.startedAt))
		.all()
		.map((row) => ({ ...row.run, startedByName: row.name }));
}

/** How many runs this person's assistants have waiting (SPEC-MCP M24). */
export function pendingCountOf(database: Queryable, userId: string): number {
	return database
		.select({ id: commandRuns.id })
		.from(commandRuns)
		.where(
			and(
				eq(commandRuns.status, 'pending-approval'),
				eq(commandRuns.startedBy, userId),
				eq(commandRuns.requester, 'assistant')
			)
		)
		.all().length;
}

/** Assistant runs not yet ended: waiting for approval or running. */
export function openAssistantRuns(database: Queryable): RunRow[] {
	return database
		.select({ run: commandRuns, name: users.name })
		.from(commandRuns)
		.innerJoin(users, eq(users.id, commandRuns.startedBy))
		.where(and(isNull(commandRuns.endedAt), eq(commandRuns.requester, 'assistant')))
		.all()
		.map((row) => ({ ...row.run, startedByName: row.name }));
}

/** Pending runs whose time to be decided has passed. */
export function expiredPendingRunIds(database: Queryable, now: number): string[] {
	return database
		.select({ id: commandRuns.id })
		.from(commandRuns)
		.where(
			and(eq(commandRuns.status, 'pending-approval'), lte(commandRuns.expiresAt, new Date(now)))
		)
		.all()
		.map((row) => row.id);
}

/**
 * A pending run's decision, only if it is still pending: approve, deny, expiry and cancel race
 * through here, and exactly one wins (SPEC-MCP 10.1). False when another got there first.
 */
export function settlePending(
	database: Queryable,
	runId: string,
	outcome:
		| { status: 'running'; decidedBy: string; startedAt: number; timeoutMs: number }
		| { status: 'denied'; decidedBy: string; note: string }
		| { status: 'expired' | 'cancelled' },
	now: number
): boolean {
	const values =
		outcome.status === 'running'
			? {
					status: outcome.status,
					decidedBy: outcome.decidedBy,
					decidedAt: new Date(now),
					startedAt: new Date(outcome.startedAt),
					timeoutMs: outcome.timeoutMs
				}
			: outcome.status === 'denied'
				? {
						status: outcome.status,
						decidedBy: outcome.decidedBy,
						decidedAt: new Date(now),
						denyNote: outcome.note,
						endedAt: new Date(now)
					}
				: { status: outcome.status, endedAt: new Date(now) };
	return (
		database
			.update(commandRuns)
			.set(values)
			.where(and(eq(commandRuns.id, runId), eq(commandRuns.status, 'pending-approval')))
			.run().changes === 1
	);
}

/** Keeps what the assistant asked for beside the approver's edit (SPEC-MCP M20). */
export function recordEdit(
	database: Queryable,
	runId: string,
	edit: { command: string; requestedCommand: string; requestedTimeoutMs: number }
): void {
	database
		.update(commandRunScripts)
		.set({ command: edit.command, requestedCommand: edit.requestedCommand })
		.where(eq(commandRunScripts.runId, runId))
		.run();
	database
		.update(commandRuns)
		.set({ requestedTimeoutMs: edit.requestedTimeoutMs })
		.where(eq(commandRuns.id, runId))
		.run();
}

/** A machine skipped when the run is approved (agent too old, unsupported system). */
export function markSkipped(
	database: Queryable,
	runId: string,
	machineId: string,
	reason: string,
	now: number
): void {
	database
		.update(commandRunMachines)
		.set({ status: 'skipped', skipReason: reason, endedAt: new Date(now) })
		.where(machineRow(runId, machineId))
		.run();
}

/** Every machine row still waiting or running in these runs, as `status`. */
export function closeUnfinishedMachines(
	database: Queryable,
	runId: string,
	from: 'waiting' | 'running',
	to: 'skipped' | 'lost',
	reason: string,
	now: number
): number {
	return database
		.update(commandRunMachines)
		.set({ status: to, skipReason: reason, endedAt: new Date(now) })
		.where(and(eq(commandRunMachines.runId, runId), eq(commandRunMachines.status, from)))
		.run().changes;
}

/** C16: stdout and stderr of machines that ended before `before` are deleted; how many rows. */
export function deleteOutputBefore(database: Queryable, before: number, now: number): number {
	return database
		.update(commandRunMachines)
		.set({ stdout: null, stderr: null, outputDeletedAt: new Date(now) })
		.where(
			and(
				lt(commandRunMachines.endedAt, new Date(before)),
				or(isNotNull(commandRunMachines.stdout), isNotNull(commandRunMachines.stderr))
			)
		)
		.run().changes;
}
