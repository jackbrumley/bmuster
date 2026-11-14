import {
	ASSISTANT_RUN_LIMITS,
	hasBidiControls,
	machineNamesText,
	type ApprovalMachine
} from '#lib/domain/commands/assistant-runs.ts';
import {
	COMMAND_SHELLS,
	commandOsLabel,
	firstLine,
	type CommandOsFamily,
	type CommandShell
} from '#lib/domain/commands/commands.ts';
import { assistantLabel } from '#lib/domain/mcp/mcp.ts';
import type { ApproveRequest } from '#lib/schemas/commands/approvals.ts';
import { commandScriptSchema } from '#lib/schemas/commands/commands.ts';
import type { AppDatabase } from '../../database/connection.ts';
import { machineIdsWith, permissionsFor, visibleMachineIds } from '../access/access.ts';
import { isAgentConnected } from '../agents/live-agents.ts';
import { publishLive } from '../live/live-events.ts';
import { activeMachineNames, machineAgentFacts } from '../machines/machine-views.ts';
import { raiseNotification } from '../notifications/events.ts';
import { findGrant, viaDetail } from '../oauth/grants.ts';
import { mcpEnabled } from '../oauth/mcp-settings.ts';
import type { McpPrincipal } from '../oauth/tokens.ts';
import { findUserById, toConsoleUser } from '../users/users.ts';
import { approverByMode, decidedAudience, requestedAudience } from './approvers.ts';
import { expireRun, settleEndedGrantRuns } from './assistant-pending.ts';
import { auditRunDenied, auditRunRequested, auditRunStarted } from './command-audit.ts';
import type { CommandRunner } from './command-runner.ts';
import {
	cancelWaiting,
	findRun,
	insertRun,
	machinesOf,
	markSkipped,
	pendingCountOf,
	recordEdit,
	scriptsOf,
	settlePending,
	type RunRow
} from './command-runs.ts';
import { agentTooOld, checkRecentSignIn, type CommandContext, type Refused } from './commands.ts';

/**
 * Commands an AI assistant asks for (SPEC-MCP M17–M22). Security work: `run_command` only
 * creates a Commands run waiting for approval; nothing reaches an agent until a person approves
 * it in the console, with their own session, a recent sign-in and `run-commands` on every
 * machine. Approving starts it through the one Commands runner, as the approver.
 */

export type AssistantContext = {
	database: AppDatabase;
	runner: CommandRunner;
	principal: McpPrincipal;
	now: number;
};

export type AssistantRequest = {
	machines: string[];
	shell: CommandShell;
	command: string;
	timeoutSeconds: number;
	reason: string;
};

export type Requested = {
	kind: 'requested';
	runId: string;
	expiresAt: number;
	machines: ApprovalMachine[];
};

type ToolRefusal = { kind: 'refused'; message: string };

function refuse(message: string): ToolRefusal {
	return { kind: 'refused', message };
}

/**
 * The machines named, each by id or by a name no other machine open to AI commands shares. A
 * machine without `ai-commands` refuses the whole call, naming it (M17).
 */
function resolveMachines(
	context: AssistantContext,
	wanted: readonly string[]
): { kind: 'ok'; ids: string[] } | ToolRefusal {
	const allowed = machineIdsWith(context.database, context.principal.user, 'ai-commands');
	const names = activeMachineNames(context.database);
	const ids: string[] = [];
	for (const raw of wanted) {
		const name = raw.trim();
		if (allowed.has(name)) {
			ids.push(name);
			continue;
		}
		const matching = [...allowed].filter(
			(id) => (names.get(id) ?? '').toLowerCase() === name.toLowerCase()
		);
		const [only] = matching;
		if (matching.length === 1 && only !== undefined) {
			ids.push(only);
			continue;
		}
		return refuse(
			matching.length > 1
				? `More than one machine is called ${name}. Use its id from list_machines.`
				: `${name} is not open to AI commands for you, so nothing was asked. Use list_machines to see the machines that are.`
		);
	}
	if (new Set(ids).size !== ids.length) {
		return refuse('A machine is named twice. Name each machine once.');
	}
	return { kind: 'ok', ids };
}

function familyOf(shell: CommandShell): CommandOsFamily {
	return COMMAND_SHELLS.windows.some((candidate) => candidate === shell) ? 'windows' : 'linux';
}

/** What happens to each machine if the request is approved now. */
export function machinePlans(
	database: AppDatabase,
	machineIds: readonly string[]
): ApprovalMachine[] {
	const facts = machineAgentFacts(database, machineIds);
	return machineIds.flatMap((id): ApprovalMachine[] => {
		const machine = facts.get(id);
		if (machine === undefined) {
			return [];
		}
		const plan = agentTooOld(machine.agentVersion)
			? 'agent-too-old'
			: isAgentConnected(id)
				? 'runs'
				: 'offline';
		return [{ id, name: machine.name, plan }];
	});
}

/**
 * `run_command` (M17): checks, then a Commands run waiting for approval. Nothing is sent to any
 * agent. The request is audited, the approvers' consoles are told, and an email goes out if a
 * notification rule asks for one.
 */
export function requestAssistantRun(
	context: AssistantContext,
	request: AssistantRequest
): Requested | ToolRefusal {
	const { database, principal, now } = context;
	if (request.machines.length < 1 || request.machines.length > ASSISTANT_RUN_LIMITS.maxMachines) {
		return refuse(`Ask for 1 to ${String(ASSISTANT_RUN_LIMITS.maxMachines)} machines in one call.`);
	}
	const resolved = resolveMachines(context, request.machines);
	if (resolved.kind === 'refused') {
		return resolved;
	}
	const family = familyOf(request.shell);
	const facts = machineAgentFacts(database, resolved.ids);
	for (const id of resolved.ids) {
		const machine = facts.get(id);
		if (machine === undefined) {
			return refuse('A machine was removed. Use list_machines to see the machines open to you.');
		}
		if (machine.osFamily === 'macos') {
			return refuse(`${machine.name} runs macOS. Commands run on Windows and Linux only.`);
		}
		if (machine.osFamily !== family) {
			return refuse(
				`${machine.name} runs ${commandOsLabel(machine.osFamily)}, and ${request.shell} is a ${commandOsLabel(family)} shell. Ask for Windows and Linux machines in separate calls, each with its own shell.`
			);
		}
	}
	const script = commandScriptSchema.safeParse({
		osFamily: family,
		shell: request.shell,
		command: request.command
	});
	if (!script.success) {
		return refuse(script.error.issues[0]?.message ?? 'The command is not valid.');
	}
	if (hasBidiControls(request.command)) {
		return refuse(
			'The command has text-direction control characters, which make it read differently from what runs. Write it without them.'
		);
	}
	if (pendingCountOf(database, principal.user.id) >= ASSISTANT_RUN_LIMITS.maxPending) {
		return refuse(
			`${String(ASSISTANT_RUN_LIMITS.maxPending)} requests already wait for approval. Wait for a decision, or withdraw one with cancel_command.`
		);
	}
	const runId = crypto.randomUUID();
	const expiresAt = now + ASSISTANT_RUN_LIMITS.expiresMs;
	const plans = machinePlans(database, resolved.ids);
	const via = viaDetail(principal.assistant, principal.clientId);
	database.transaction((transaction) => {
		insertRun(transaction, {
			id: runId,
			startedBy: principal.user.id,
			startedAt: now,
			timeoutMs: request.timeoutSeconds * 1000,
			rerunOf: null,
			origin: { kind: 'assistant', grantId: principal.grantId, reason: request.reason, expiresAt },
			scripts: [script.data],
			machines: resolved.ids.map((machineId) => ({
				machineId,
				status: 'waiting',
				skipReason: null
			}))
		});
		auditRunRequested(
			transaction,
			{
				runId,
				userId: principal.user.id,
				via,
				machines: plans.map((plan) => ({ id: plan.id, name: plan.name })),
				shell: request.shell,
				command: request.command,
				timeoutMs: request.timeoutSeconds * 1000,
				reason: request.reason
			},
			now
		);
		const [first] = resolved.ids;
		if (first !== undefined) {
			raiseNotification(
				transaction,
				{
					kind: 'command-approval-requested',
					machineId: first,
					detail: {
						runId,
						machines: machineNamesText(plans.map((plan) => plan.name)),
						requestedBy: principal.user.name,
						assistant: assistantLabel(principal.assistant),
						firstLine: firstLine(request.command)
					}
				},
				now
			);
		}
	});
	publishLive(requestedAudience(database, runId));
	return { kind: 'requested', runId, expiresAt, machines: plans };
}

const NOT_FOUND: Refused = { kind: 'refused', status: 404, message: 'No request with this id.' };

/** The run, if this person may decide it: the setting lets them, and they can see every machine. */
function decidableRun(
	context: CommandContext,
	runId: string
): { kind: 'found'; run: RunRow } | Refused {
	const run = findRun(context.database, runId);
	if (run?.requester !== 'assistant' || !approverByMode(context.database, context.user, run)) {
		return NOT_FOUND;
	}
	const visible = visibleMachineIds(context.database, context.user);
	if (!machinesOf(context.database, [runId]).every((machine) => visible.has(machine.machineId))) {
		return NOT_FOUND;
	}
	return { kind: 'found', run };
}

/** Why a run that is no longer pending cannot be decided: who decided it, or what ended it. */
function alreadyDecided(context: CommandContext, runId: string): Refused {
	const run = findRun(context.database, runId);
	const by =
		run?.decidedBy === null || run?.decidedBy === undefined
			? undefined
			: findUserById(context.database, run.decidedBy)?.name;
	switch (run?.status) {
		case 'expired':
			return {
				kind: 'refused',
				status: 409,
				message: 'This request expired without a decision. The assistant was told.'
			};
		case 'cancelled':
			if (by === undefined) {
				return { kind: 'refused', status: 409, message: 'This request was withdrawn.' };
			}
			break;
		case undefined:
		case 'pending-approval':
		case 'running':
		case 'finished':
		case 'denied':
			break;
	}
	return {
		kind: 'refused',
		status: 409,
		message: `Already decided by ${by ?? 'someone else'}.`
	};
}

/** Checks a pending run is still pending: expired first if its time passed. */
function stillPending(context: CommandContext, run: RunRow): Refused | undefined {
	expireRun(context, run.id);
	return findRun(context.database, run.id)?.status === 'pending-approval'
		? undefined
		: alreadyDecided(context, run.id);
}

/** M18: the assistant may still ask: MCP on, the grant live, `ai-commands` on every machine. */
function requesterRefusal(
	context: CommandContext,
	run: RunRow,
	machineIds: string[]
): Refused | undefined {
	const grant =
		run.oauthGrantId === null ? undefined : findGrant(context.database, run.oauthGrantId);
	if (!mcpEnabled(context.database) || grant?.endedAt !== null) {
		settleEndedGrantRuns(context);
		return {
			kind: 'refused',
			status: 409,
			message: 'The assistant is no longer connected, so this request cannot run.'
		};
	}
	const requester = findUserById(context.database, run.startedBy);
	if (requester?.disabledAt !== null) {
		return {
			kind: 'refused',
			status: 409,
			message: 'The person the assistant acts as was disabled.'
		};
	}
	const names = activeMachineNames(context.database);
	const lacking = machineIds.filter(
		(id) =>
			!permissionsFor(context.database, toConsoleUser(requester), id).some(
				(granted) => granted.permission === 'ai-commands'
			)
	);
	return lacking.length === 0
		? undefined
		: {
				kind: 'refused',
				status: 403,
				message: `${requester.name} no longer has AI commands on ${lacking.map((id) => names.get(id) ?? 'a removed machine').join(', ')}.`
			};
}

/**
 * Approve, or Edit then approve (M18–M20). Every check is made again here; the decision is one
 * conditional write, so two people deciding at once settle on one. The run then starts through
 * the Commands runner as the approver: each ticket names them and carries their permissions.
 */
export async function approveRun(
	context: CommandContext,
	runId: string,
	request: ApproveRequest
): Promise<{ kind: 'approved'; runId: string } | Refused> {
	const found = decidableRun(context, runId);
	if (found.kind === 'refused') {
		return found;
	}
	const run = found.run;
	const pending = stillPending(context, run);
	if (pending !== undefined) {
		return pending;
	}
	const machineIds = machinesOf(context.database, [runId]).map((machine) => machine.machineId);
	const requester = requesterRefusal(context, run, machineIds);
	if (requester !== undefined) {
		return requester;
	}
	const names = activeMachineNames(context.database);
	const forbidden = machineIds.filter(
		(id) =>
			!permissionsFor(context.database, context.user, id).some(
				(granted) => granted.permission === 'run-commands'
			)
	);
	if (forbidden.length > 0) {
		return {
			kind: 'refused',
			status: 403,
			message: `You cannot run commands on ${forbidden.map((id) => names.get(id) ?? 'a removed machine').join(', ')}, so you cannot approve this. Someone who can must approve it.`
		};
	}
	if (request.confirmCount !== machineIds.length) {
		return {
			kind: 'refused',
			status: 400,
			message: `Type ${String(machineIds.length)}, the number of machines, to confirm.`
		};
	}
	const [stored] = scriptsOf(context.database, [runId]);
	if (stored === undefined) {
		throw new Error(`Command run ${runId} has no command`);
	}
	const script = commandScriptSchema.safeParse({
		osFamily: stored.osFamily,
		shell: stored.shell,
		command: request.command
	});
	if (!script.success) {
		return {
			kind: 'refused',
			status: 400,
			message: script.error.issues[0]?.message ?? 'The command is not valid.'
		};
	}
	if (hasBidiControls(request.command)) {
		return {
			kind: 'refused',
			status: 400,
			message: 'The command has text-direction control characters. Remove them.'
		};
	}
	const signIn = await checkRecentSignIn(context, request.recheck);
	if (signIn !== undefined) {
		return signIn;
	}
	const edited = request.command !== stored.command || request.timeoutMs !== run.timeoutMs;
	const grant =
		run.oauthGrantId === null ? undefined : findGrant(context.database, run.oauthGrantId);
	const plans = machinePlans(context.database, machineIds);
	const approved = context.database.transaction((transaction) => {
		const won = settlePending(
			transaction,
			runId,
			{
				status: 'running',
				decidedBy: context.user.id,
				startedAt: context.now,
				timeoutMs: request.timeoutMs
			},
			context.now
		);
		if (!won) {
			return false;
		}
		if (edited) {
			recordEdit(transaction, runId, {
				command: request.command,
				requestedCommand: stored.command,
				requestedTimeoutMs: run.timeoutMs
			});
		}
		for (const plan of plans) {
			if (plan.plan === 'agent-too-old') {
				markSkipped(transaction, runId, plan.id, 'Agent too old (update first)', context.now);
			}
		}
		auditRunStarted(
			transaction,
			{
				id: runId,
				userId: context.user.id,
				scripts: [script.data],
				timeoutMs: request.timeoutMs,
				machineCount: machineIds.length,
				skippedCount: plans.filter((plan) => plan.plan === 'agent-too-old').length,
				rerunOf: null,
				approval: {
					kind: 'approved',
					requestedBy: run.startedByName,
					assistant: grant === undefined ? 'an AI assistant' : assistantLabel(grant.assistant),
					edit: edited
						? { kind: 'edited', requestedCommand: stored.command }
						: { kind: 'unchanged' }
				}
			},
			context.now
		);
		return true;
	});
	if (!approved) {
		return alreadyDecided(context, runId);
	}
	context.runner.begin(runId, context.ip);
	publishLive(decidedAudience(context.database, run));
	return { kind: 'approved', runId };
}

/** Deny, with a note the assistant reads (M20). Nothing runs. */
export function denyRun(
	context: CommandContext,
	runId: string,
	note: string
): { kind: 'denied'; runId: string } | Refused {
	const found = decidableRun(context, runId);
	if (found.kind === 'refused') {
		return found;
	}
	const run = found.run;
	const pending = stillPending(context, run);
	if (pending !== undefined) {
		return pending;
	}
	const grant =
		run.oauthGrantId === null ? undefined : findGrant(context.database, run.oauthGrantId);
	const machineNames = machinesOf(context.database, [runId]).map((machine) => machine.machineName);
	const denied = context.database.transaction((transaction) => {
		if (
			!settlePending(
				transaction,
				runId,
				{ status: 'denied', decidedBy: context.user.id, note: note.trim() },
				context.now
			)
		) {
			return false;
		}
		cancelWaiting(transaction, runId, context.now);
		auditRunDenied(
			transaction,
			{
				runId,
				approverId: context.user.id,
				requestedBy: run.startedByName,
				assistant: grant === undefined ? 'an AI assistant' : assistantLabel(grant.assistant),
				machineNames,
				note: note.trim()
			},
			context.now
		);
		return true;
	});
	if (!denied) {
		return alreadyDecided(context, runId);
	}
	context.runner.announce(runId);
	publishLive(decidedAudience(context.database, run));
	return { kind: 'denied', runId };
}
