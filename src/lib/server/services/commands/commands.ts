import type { SignInCheck } from '#lib/domain/auth/sign-in-check.ts';
import {
	COMMAND_LIMITS,
	FIRST_COMMANDS_AGENT,
	commandOsLabel,
	skipReasonLabel,
	type CommandOsFamily,
	type PlannedMachine,
	type SkipReason
} from '#lib/domain/commands/commands.ts';
import { compareAgentVersions, isAgentVersion } from '#lib/domain/machines/agent-version.ts';
import type { OsFamily } from '#lib/domain/machines/machine.ts';
import type { ConsoleUser } from '#lib/domain/users/user.ts';
import type { StartRunRequest } from '#lib/schemas/commands/commands.ts';
import type { AppDatabase } from '../../database/connection.ts';
import { permissionsFor } from '../access/access.ts';
import { isAgentConnected } from '../agents/live-agents.ts';
import { reconfirmPassword, signInCheck, SIGN_IN_AGAIN } from '../auth/recent-sign-in.ts';
import { machineAgentFacts } from '../machines/machine-views.ts';
import { auditRunCancelled, auditRunStarted } from './command-audit.ts';
import type { CommandRunner } from './command-runner.ts';
import { cancelWaiting, findRun, insertRun, setRunStatus } from './command-runs.ts';

/**
 * Starting and cancelling command runs (SPEC-COMMANDS C8–C17). Everything the browser sends is
 * checked again here: every machine with the access service (a selection with one forbidden
 * machine is refused whole, never trimmed), the typed count, and a recent sign-in.
 */

export type CommandContext = {
	database: AppDatabase;
	runner: CommandRunner;
	user: ConsoleUser;
	/** The console session's cookie, for the recent sign-in check. */
	sessionToken: string;
	ip: string;
	now: number;
};

export type Refused = { kind: 'refused'; status: 400 | 403 | 404 | 429; message: string };

type MachineFacts = { id: string; name: string; osFamily: OsFamily; agentVersion: string };

/** The machines asked for, every one visible to the person; else the refusal. */
function visibleMachines(
	context: Pick<CommandContext, 'database' | 'user'>,
	machineIds: readonly string[]
): { kind: 'ok'; machines: MachineFacts[] } | Refused {
	const facts = machineAgentFacts(context.database, machineIds);
	const found: MachineFacts[] = [];
	for (const id of machineIds) {
		const machine = facts.get(id);
		const canSee = permissionsFor(context.database, context.user, id).some(
			(grant) => grant.permission === 'view'
		);
		if (machine === undefined || !canSee) {
			return { kind: 'refused', status: 404, message: 'No machine with this id.' };
		}
		found.push({ id, ...machine });
	}
	return { kind: 'ok', machines: found };
}

/** Why this machine would not run now, or undefined when it would (C8, C15). */
function skipReasonOf(
	context: Pick<CommandContext, 'database' | 'user'>,
	machine: MachineFacts
): SkipReason | undefined {
	const allowed = permissionsFor(context.database, context.user, machine.id).some(
		(grant) => grant.permission === 'run-commands'
	);
	if (!allowed) {
		return 'no-permission';
	}
	if (machine.osFamily === 'macos') {
		return 'unsupported-system';
	}
	if (
		!isAgentVersion(machine.agentVersion) ||
		compareAgentVersions(machine.agentVersion, FIRST_COMMANDS_AGENT) < 0
	) {
		return 'agent-too-old';
	}
	return isAgentConnected(machine.id) ? undefined : 'offline';
}

/** What Review shows for these machines (C8), and whether the password is needed (C10). */
export function planRun(
	context: Pick<CommandContext, 'database' | 'user' | 'sessionToken' | 'now'>,
	machineIds: readonly string[]
): { kind: 'planned'; machines: PlannedMachine[]; signIn: SignInCheck } | Refused {
	const found = visibleMachines(context, machineIds);
	if (found.kind === 'refused') {
		return found;
	}
	return {
		kind: 'planned',
		machines: found.machines.map((machine) => {
			const reason = skipReasonOf(context, machine);
			return {
				id: machine.id,
				name: machine.name,
				osFamily: machine.osFamily,
				plan: reason === undefined ? { kind: 'runs' } : { kind: 'skipped', reason }
			};
		}),
		signIn: signInCheck(
			context.database,
			context.sessionToken,
			context.user.id,
			COMMAND_LIMITS.recentSignInMs,
			context.now
		)
	};
}

/** C10: a recent sign-in, or the password now. */
async function checkRecentSignIn(
	context: CommandContext,
	password: StartRunRequest['password']
): Promise<Refused | undefined> {
	const check = signInCheck(
		context.database,
		context.sessionToken,
		context.user.id,
		COMMAND_LIMITS.recentSignInMs,
		context.now
	);
	switch (check.kind) {
		case 'recent':
			return undefined;
		case 'sign-in-again':
			return { kind: 'refused', status: 403, message: SIGN_IN_AGAIN };
		case 'password': {
			if (password.kind === 'none') {
				return {
					kind: 'refused',
					status: 403,
					message: 'You signed in more than 10 minutes ago. Type your password to run it.'
				};
			}
			const confirmed = await reconfirmPassword(
				context.database,
				{
					token: context.sessionToken,
					userId: context.user.id,
					password: password.password,
					ip: context.ip
				},
				context.now
			);
			return confirmed.kind === 'confirmed' ? undefined : confirmed;
		}
	}
}

/** Starts a run (C8–C15). Machines skipped at the start are recorded with their reason. */
export async function startRun(
	context: CommandContext,
	request: StartRunRequest
): Promise<{ kind: 'started'; runId: string } | Refused> {
	const found = visibleMachines(context, request.machineIds);
	if (found.kind === 'refused') {
		return found;
	}
	const machines = found.machines.map((machine) => ({
		machine,
		reason: skipReasonOf(context, machine)
	}));
	// C12: refused whole, naming the machines, never trimmed.
	const forbidden = machines.filter((entry) => entry.reason === 'no-permission');
	if (forbidden.length > 0) {
		return {
			kind: 'refused',
			status: 403,
			message: `You cannot run commands on ${forbidden.map((entry) => entry.machine.name).join(', ')}. Take them out of the selection and try again.`
		};
	}
	// C9: the count typed in the confirmation, checked here too.
	if (request.confirmCount !== request.machineIds.length) {
		return {
			kind: 'refused',
			status: 400,
			message: `Type ${request.machineIds.length}, the number of machines, to confirm.`
		};
	}
	// C6: one command for each system that will run one, and none for a system that will not.
	const systems = new Set<CommandOsFamily>();
	for (const { machine } of machines) {
		if (machine.osFamily !== 'macos') {
			systems.add(machine.osFamily);
		}
	}
	for (const family of systems) {
		if (!request.scripts.some((script) => script.osFamily === family)) {
			return {
				kind: 'refused',
				status: 400,
				message: `Write a command for the ${commandOsLabel(family)} machines.`
			};
		}
	}
	const extra = request.scripts.find((script) => !systems.has(script.osFamily));
	if (extra !== undefined) {
		return {
			kind: 'refused',
			status: 400,
			message: `No machine in the selection runs ${commandOsLabel(extra.osFamily)}.`
		};
	}
	if (request.rerunOf !== null && findRun(context.database, request.rerunOf) === undefined) {
		return { kind: 'refused', status: 404, message: 'No command run with this id.' };
	}
	const signIn = await checkRecentSignIn(context, request.password);
	if (signIn !== undefined) {
		return signIn;
	}

	const runId = crypto.randomUUID();
	// Offline machines wait their turn: they may be back by then (C15).
	const rows = machines.map(({ machine, reason }) =>
		reason === undefined || reason === 'offline'
			? { machineId: machine.id, status: 'waiting' as const, skipReason: null }
			: { machineId: machine.id, status: 'skipped' as const, skipReason: skipReasonLabel(reason) }
	);
	context.database.transaction((transaction) => {
		insertRun(transaction, {
			id: runId,
			startedBy: context.user.id,
			startedAt: context.now,
			timeoutMs: request.timeoutMs,
			rerunOf: request.rerunOf,
			scripts: request.scripts,
			machines: rows
		});
		auditRunStarted(
			transaction,
			{
				id: runId,
				userId: context.user.id,
				scripts: request.scripts,
				timeoutMs: request.timeoutMs,
				machineCount: rows.length,
				skippedCount: rows.filter((row) => row.status === 'skipped').length,
				rerunOf: request.rerunOf
			},
			context.now
		);
	});
	context.runner.begin(runId, context.ip);
	return { kind: 'started', runId };
}

/**
 * C17: machines that have not started are cancelled; machines already running finish or reach
 * their time limit. The person who started the run, or an admin, may cancel it.
 */
export function cancelRun(
	context: Pick<CommandContext, 'database' | 'runner' | 'user' | 'now'>,
	runId: string
): { kind: 'cancelled'; notStarted: number } | Refused {
	const run = findRun(context.database, runId);
	if (run === undefined || !mayCancel(context.user, run.startedBy)) {
		return { kind: 'refused', status: 404, message: 'No command run with this id.' };
	}
	if (run.endedAt !== null || run.status !== 'running') {
		return { kind: 'refused', status: 400, message: 'This run has already ended.' };
	}
	const notStarted = context.database.transaction((transaction) => {
		const count = cancelWaiting(transaction, runId, context.now);
		setRunStatus(transaction, runId, 'cancelled');
		auditRunCancelled(
			transaction,
			{ runId, userId: context.user.id, notStarted: count },
			context.now
		);
		return count;
	});
	context.runner.settle(runId);
	return { kind: 'cancelled', notStarted };
}

export function mayCancel(user: ConsoleUser, startedBy: string): boolean {
	return user.role === 'admin' || user.id === startedBy;
}
