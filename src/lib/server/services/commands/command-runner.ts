import {
	COMMAND_LIMITS,
	emptyCounts,
	type CommandScript,
	type RunCounts
} from '#lib/domain/commands/commands.ts';
import type { AppDatabase } from '../../database/connection.ts';
import { permissionsFor } from '../access/access.ts';
import { isAgentConnected } from '../agents/live-agents.ts';
import { activeMachineBasics } from '../machines/machine-views.ts';
import type { Relay } from '../sessions/relay.ts';
import { findUserById, toConsoleUser } from '../users/users.ts';
import { auditMachineResult, auditRunEnded } from './command-audit.ts';
import { runOnMachine } from './command-exec.ts';
import {
	endRun,
	finishMachine,
	findRun,
	machinesOf,
	markNotRun,
	markRunning,
	scriptsOf,
	waitingMachines
} from './command-runs.ts';

/**
 * Runs live on the server (SPEC-COMMANDS C14–C17): each run starts at most 10 machines at a
 * time and the next as each finishes, so a bad command never reaches every machine in the same
 * second. Every machine is checked again when its turn comes: still there, still online, its
 * owner still allowed. Closing the browser does nothing to a run; listeners hear each change
 * (the results page's live updates).
 */

export type RunnerDeps = {
	database: AppDatabase;
	relay: Relay;
	secretsKey: Buffer;
	clock: () => number;
};

type ActiveRun = {
	running: number;
	startedBy: string;
	startedAt: number;
	timeoutMs: number;
	scripts: CommandScript[];
	ip: string;
};

export type CommandRunner = ReturnType<typeof createCommandRunner>;

export function createCommandRunner(deps: RunnerDeps) {
	const { database, relay, secretsKey, clock } = deps;
	const active = new Map<string, ActiveRun>();
	const listeners = new Set<(runId: string) => void>();

	function changed(runId: string): void {
		for (const listener of listeners) {
			listener(runId);
		}
	}

	function countsOf(runId: string): RunCounts {
		const counts = emptyCounts();
		for (const row of machinesOf(database, [runId])) {
			counts[row.status] += 1;
		}
		return counts;
	}

	/** The run is over once nothing waits or runs: it ends, with its totals audited. */
	function endIfDone(runId: string, run: ActiveRun): void {
		if (run.running > 0 || waitingMachines(database, runId).length > 0) {
			return;
		}
		active.delete(runId);
		const now = clock();
		const status = findRun(database, runId)?.status === 'cancelled' ? 'cancelled' : 'finished';
		endRun(database, runId, status, now);
		auditRunEnded(
			database,
			{
				runId,
				startedBy: run.startedBy,
				counts: countsOf(runId),
				durationMs: now - run.startedAt
			},
			now
		);
	}

	/** A machine whose turn came but which will not run. */
	function notRun(
		runId: string,
		run: ActiveRun,
		machine: { id: string; name: string },
		status: 'offline' | 'skipped',
		reason: string | null
	): void {
		const now = clock();
		markNotRun(database, runId, machine.id, status, reason, now);
		auditMachineResult(
			database,
			{
				runId,
				userId: run.startedBy,
				machineId: machine.id,
				machineName: machine.name,
				status,
				reason,
				exitCode: null,
				durationMs: null,
				outputBytes: null,
				outputSha256: null,
				sessionId: null
			},
			now
		);
	}

	/** Starts one machine, or records why it cannot start. */
	function launch(runId: string, run: ActiveRun, machineId: string): void {
		const basics = activeMachineBasics(database, machineId);
		const name = basics?.name ?? 'Removed machine';
		const machine = { id: machineId, name };
		if (basics === undefined) {
			notRun(runId, run, machine, 'skipped', 'The machine was removed.');
			return;
		}
		const owner = findUserById(database, run.startedBy);
		if (owner?.disabledAt !== null) {
			notRun(runId, run, machine, 'skipped', 'The person who started the run was disabled.');
			return;
		}
		const user = toConsoleUser(owner);
		const grants = permissionsFor(database, user, machineId);
		if (!grants.some((grant) => grant.permission === 'run-commands')) {
			notRun(runId, run, machine, 'skipped', 'Run commands was taken away before its turn.');
			return;
		}
		const script = run.scripts.find((candidate) => candidate.osFamily === basics.osFamily);
		if (script === undefined) {
			notRun(runId, run, machine, 'skipped', 'The run has no command for its system.');
			return;
		}
		if (!isAgentConnected(machineId)) {
			notRun(runId, run, machine, 'offline', null);
			return;
		}
		const now = clock();
		const sent = runOnMachine(
			database,
			relay,
			secretsKey,
			{
				runId,
				machineId,
				user: { id: user.id, name: user.name },
				permissions: grants.map((grant) => grant.permission),
				shell: script.shell,
				command: script.command,
				timeoutMs: run.timeoutMs,
				ip: run.ip
			},
			now,
			(result) => {
				const ended = clock();
				finishMachine(database, runId, machineId, result, ended);
				auditMachineResult(
					database,
					{
						runId,
						userId: run.startedBy,
						machineId,
						machineName: name,
						status: result.status,
						reason: result.reason,
						exitCode: result.exitCode,
						durationMs: result.durationMs,
						outputBytes: result.outputBytes,
						outputSha256: result.outputSha256,
						sessionId: result.sessionId
					},
					ended
				);
				run.running -= 1;
				pump(runId);
			}
		);
		switch (sent.kind) {
			case 'offline':
				notRun(runId, run, machine, 'offline', null);
				return;
			case 'sent':
				markRunning(database, runId, machineId, sent.sessionId, now);
				run.running += 1;
				return;
		}
	}

	/** Starts machines until 10 are running or none is waiting. */
	function pump(runId: string): void {
		const run = active.get(runId);
		if (run === undefined) {
			return;
		}
		while (run.running < COMMAND_LIMITS.maxRunning) {
			const next = waitingMachines(database, runId)[0];
			if (next === undefined) {
				break;
			}
			launch(runId, run, next);
		}
		endIfDone(runId, run);
		changed(runId);
	}

	return {
		/** Starts a run already in the database (its machines waiting). */
		begin(runId: string, ip: string): void {
			const row = findRun(database, runId);
			if (row === undefined) {
				throw new Error(`No command run ${runId} to begin`);
			}
			active.set(runId, {
				running: 0,
				startedBy: row.startedBy,
				startedAt: row.startedAt.getTime(),
				timeoutMs: row.timeoutMs,
				scripts: scriptsOf(database, [runId]).map((script) => ({
					osFamily: script.osFamily,
					shell: script.shell,
					command: script.command
				})),
				ip
			});
			pump(runId);
		},

		/** After a cancel: a run with nothing running ends now. */
		settle(runId: string): void {
			pump(runId);
		},

		/** Listens for changes to any run until the returned function is called. */
		onChange(listener: (runId: string) => void): () => void {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},

		isActive(runId: string): boolean {
			return active.has(runId);
		}
	};
}

/**
 * The server's runner. Kept on globalThis like the relay: the dev server can load this module
 * more than once, and every copy must see the same runs.
 */
const RUNNER_KEY = Symbol.for('bmuster.command-runner');

export function commandRunner(deps: RunnerDeps): CommandRunner {
	const existing: unknown = Reflect.get(globalThis, RUNNER_KEY);
	if (isRunner(existing)) {
		return existing;
	}
	const created = createCommandRunner(deps);
	Reflect.set(globalThis, RUNNER_KEY, created);
	return created;
}

function isRunner(value: unknown): value is CommandRunner {
	return (
		typeof value === 'object' &&
		value !== null &&
		'begin' in value &&
		typeof value.begin === 'function' &&
		'onChange' in value &&
		typeof value.onChange === 'function'
	);
}
