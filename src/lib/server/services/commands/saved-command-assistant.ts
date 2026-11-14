import { ASSISTANT_RUN_LIMITS } from '#lib/domain/commands/assistant-runs.ts';
import { commandOsLabel, type CommandOsFamily } from '#lib/domain/commands/commands.ts';
import {
	SAVED_COMMAND_LIMITS,
	savedEffectLabel,
	textPatternRegex,
	type SavedCommandView,
	type SavedParameter
} from '#lib/domain/commands/saved-commands.ts';
import type { ListSavedCommandsOutput } from '#lib/schemas/mcp/tools.ts';
import type { Queryable } from '../../database/connection.ts';
import { machineIdsWith, permissionsFor } from '../access/access.ts';
import { activeMachineNames, machineAgentFacts } from '../machines/machine-views.ts';
import { findGrant, viaDetail } from '../oauth/grants.ts';
import { unattendedAllowed } from '../oauth/mcp-settings.ts';
import {
	holdForApproval,
	machinePlans,
	refuse,
	resolveMachines,
	type AssistantContext,
	type Requested,
	type ToolRefusal
} from './assistant-runs.ts';
import { auditRunStarted } from './command-audit.ts';
import { insertRun, preApprovedRunsSince } from './command-runs.ts';
import {
	checkValues,
	composedScripts,
	machinesInGroups,
	placeProblem
} from './saved-command-runs.ts';
import { allSavedCommands, findSavedCommand } from './saved-commands.ts';

/**
 * Saved commands for AI assistants (SPEC-SAVED-COMMANDS SC15–SC22). Security work: this is the one
 * way an assistant's command runs without a person approving it. It does only when every
 * condition holds, checked here and again at each machine's turn (`unattendedRefusal`, which the
 * runner calls): the command's AI switch, the server switch, the hourly cap, and on every machine
 * `ai-commands`, `run-commands` and the command's groups. Otherwise it waits on Approvals like any
 * assistant request. The assistant never sees the script text.
 */

const HOUR_MS = 60 * 60_000;

/** Runs this grant may still start without approval in the hour to `now` (SC20). */
function unattendedLeft(database: Queryable, grantId: string, now: number): number {
	return Math.max(
		0,
		SAVED_COMMAND_LIMITS.unattendedPerHour - preApprovedRunsSince(database, grantId, now - HOUR_MS)
	);
}

function parameterOutput(
	parameter: SavedParameter
): ListSavedCommandsOutput['commands'][number]['parameters'][number] {
	const base = { name: parameter.name, label: parameter.label };
	switch (parameter.kind) {
		case 'number':
			return {
				...base,
				type: 'whole-number',
				min: parameter.min,
				max: parameter.max,
				choices: [],
				pattern: null
			};
		case 'choice':
			return {
				...base,
				type: 'choice',
				min: null,
				max: null,
				choices: parameter.choices,
				pattern: null
			};
		case 'text':
			return {
				...base,
				type: 'text',
				min: null,
				max: null,
				choices: [],
				pattern: textPatternRegex(parameter.pattern).source
			};
	}
}

/** The machines the assistant may use this command on: `ai-commands`, its groups, its systems. */
function assistantMachines(
	database: Queryable,
	aiMachines: ReadonlySet<string>,
	command: SavedCommandView
): { id: string; name: string; system: CommandOsFamily }[] {
	const inGroups = machinesInGroups(database, command.machineGroupIds);
	const ids = [...aiMachines].filter((id) => inGroups.has(id));
	const facts = machineAgentFacts(database, ids);
	return ids
		.flatMap((id) => {
			const machine = facts.get(id);
			if (machine === undefined || machine.osFamily === 'macos') {
				return [];
			}
			const system: CommandOsFamily = machine.osFamily;
			return command.systems.includes(system) ? [{ id, name: machine.name, system }] : [];
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

/** `list_saved_commands` (SC15): what this person's assistant may use, never the scripts. */
export function listSavedForAssistant(context: AssistantContext): ListSavedCommandsOutput {
	const { database, principal, now } = context;
	const aiMachines = machineIdsWith(database, principal.user, 'ai-commands');
	const runMachines = machineIdsWith(database, principal.user, 'run-commands');
	const left = unattendedLeft(database, principal.grantId, now);
	const switchedOn = unattendedAllowed(database);
	return {
		commands: allSavedCommands(database).flatMap((command) => {
			if (!command.enabled) {
				return [];
			}
			const machines = assistantMachines(database, aiMachines, command);
			if (machines.length === 0) {
				return [];
			}
			const withoutApproval = command.aiUnattended && switchedOn;
			return [
				{
					id: command.id,
					name: command.name,
					description: command.description,
					label: savedEffectLabel(command.effect),
					systems: command.systems,
					parameters: command.parameters.map(parameterOutput),
					runsWithoutApproval: withoutApproval,
					machines: machines.map((machine) => ({
						...machine,
						runsWithoutApproval: withoutApproval && runMachines.has(machine.id)
					}))
				}
			];
		}),
		runsWithoutApprovalLeftThisHour: left
	};
}

/** The switched-on command named by id or by name (any case). */
function namedCommand(database: Queryable, wanted: string): SavedCommandView | undefined {
	const name = wanted.trim();
	const commands = allSavedCommands(database).filter((command) => command.enabled);
	return (
		commands.find((command) => command.id === name) ??
		commands.find((command) => command.name.toLowerCase() === name.toLowerCase())
	);
}

/**
 * Why this request cannot run without approval, one sentence per failed condition; none when
 * every condition holds (SC17). `ai-commands` and the groups were checked before: a machine
 * without them is refused outright.
 */
function approvalReasons(
	context: AssistantContext,
	command: SavedCommandView,
	machineIds: readonly string[]
): string[] {
	const { database, principal, now } = context;
	const names = activeMachineNames(database);
	const lacking = machineIds.filter(
		(id) =>
			!permissionsFor(database, principal.user, id).some(
				(grant) => grant.permission === 'run-commands'
			)
	);
	return [
		...(command.aiUnattended
			? []
			: [`an admin has not let AI run ${command.name} without approval`]),
		...(unattendedAllowed(database)
			? []
			: ['this server does not let AI run saved commands without approval']),
		...(lacking.length === 0
			? []
			: [
					`${principal.user.name} cannot run commands on ${lacking.map((id) => names.get(id) ?? 'a removed machine').join(', ')}`
				]),
		...(unattendedLeft(database, principal.grantId, now) > 0
			? []
			: [
					`this connection already ran ${String(SAVED_COMMAND_LIMITS.unattendedPerHour)} saved commands without approval in the last hour`
				])
	];
}

export type SavedRequest =
	{ kind: 'started'; runId: string } | (Requested & { whyApproval: string }) | ToolRefusal;

/**
 * `run_saved_command` (SC16, SC17): every check, then either a run that starts at once as the
 * person, or a request held for approval with why. Nothing else is ever sent.
 */
export function runSavedForAssistant(
	context: AssistantContext,
	request: {
		command: string;
		machines: string[];
		parameters: Record<string, string | number>;
		reason: string;
	}
): SavedRequest {
	const { database, principal, now } = context;
	const command = namedCommand(database, request.command);
	if (command === undefined) {
		return refuse(
			`No saved command called ${request.command} is open to you. Use list_saved_commands to see them.`
		);
	}
	if (request.machines.length < 1 || request.machines.length > ASSISTANT_RUN_LIMITS.maxMachines) {
		return refuse(`Ask for 1 to ${String(ASSISTANT_RUN_LIMITS.maxMachines)} machines in one call.`);
	}
	const resolved = resolveMachines(context, request.machines);
	if (resolved.kind === 'refused') {
		return resolved;
	}
	const facts = machineAgentFacts(database, resolved.ids);
	const inGroups = machinesInGroups(database, command.machineGroupIds);
	const systems = new Set<CommandOsFamily>();
	for (const id of resolved.ids) {
		const machine = facts.get(id);
		if (machine === undefined) {
			return refuse('A machine was removed. Use list_machines to see the machines open to you.');
		}
		const problem = placeProblem(command, inGroups, { id, ...machine });
		if (problem !== undefined) {
			return refuse(`${problem} Nothing was run.`);
		}
		if (machine.osFamily !== 'macos') {
			systems.add(machine.osFamily);
		}
	}
	const [system, other] = [...systems];
	if (system === undefined || other !== undefined) {
		return refuse(
			`Ask for ${commandOsLabel('windows')} and ${commandOsLabel('linux')} machines in separate calls.`
		);
	}
	const values = checkValues(command, request.parameters);
	if (values.kind === 'refused') {
		return refuse(values.message);
	}
	const composed = composedScripts(command, [system], values.values);
	const [script] = composed.kind === 'ok' ? composed.scripts : [];
	if (composed.kind === 'refused' || script === undefined) {
		return refuse(composed.kind === 'refused' ? composed.message : 'The command is not valid.');
	}
	const saved = {
		kind: 'saved' as const,
		id: command.id,
		name: command.name,
		version: command.version,
		effect: command.effect,
		values: values.values
	};
	const reasons = approvalReasons(context, command, resolved.ids);
	if (reasons.length > 0) {
		const whyApproval = `It needs approval because ${reasons.join('; ')}.`;
		const held = holdForApproval(context, {
			machineIds: resolved.ids,
			script,
			timeoutMs: command.timeoutMs,
			reason: request.reason,
			saved,
			whyApproval
		});
		return held.kind === 'refused' ? held : { ...held, whyApproval };
	}
	const runId = crypto.randomUUID();
	const plans = machinePlans(database, resolved.ids);
	const via = viaDetail(principal.assistant, principal.clientId);
	const tooOld = plans.filter((plan) => plan.plan === 'agent-too-old').map((plan) => plan.id);
	database.transaction((transaction) => {
		insertRun(transaction, {
			id: runId,
			startedBy: principal.user.id,
			startedAt: now,
			timeoutMs: command.timeoutMs,
			rerunOf: null,
			origin: { kind: 'pre-approved', grantId: principal.grantId, reason: request.reason },
			saved,
			scripts: [script],
			machines: resolved.ids.map((machineId) =>
				tooOld.includes(machineId)
					? { machineId, status: 'skipped', skipReason: 'Agent too old (update first)' }
					: { machineId, status: 'waiting', skipReason: null }
			)
		});
		auditRunStarted(
			transaction,
			{
				id: runId,
				userId: principal.user.id,
				scripts: [script],
				timeoutMs: command.timeoutMs,
				machineCount: resolved.ids.length,
				skippedCount: tooOld.length,
				rerunOf: null,
				saved,
				approval: { kind: 'pre-approved', via, savedName: command.name }
			},
			now
		);
	});
	context.runner.begin(runId, findGrant(database, principal.grantId)?.lastIp ?? '');
	return { kind: 'started', runId };
}

/**
 * At each machine's turn in an unattended run (SC19): why it may no longer run without approval
 * there, or undefined. The SPEC-MCP M18 checks (MCP on, grant live, `ai-commands`) and the
 * person's `run-commands` are the runner's own.
 */
export function unattendedRefusal(
	database: Queryable,
	run: { savedCommandId: string | null; savedCommandVersion: number | null },
	machineId: string
): string | undefined {
	const command =
		run.savedCommandId === null ? undefined : findSavedCommand(database, run.savedCommandId);
	if (command === undefined) {
		return 'The saved command was deleted before its turn.';
	}
	if (!command.enabled) {
		return 'The saved command was switched off before its turn.';
	}
	if (command.version !== run.savedCommandVersion) {
		return 'The saved command was changed before its turn.';
	}
	if (!command.aiUnattended) {
		return 'AI may no longer run the saved command without approval.';
	}
	if (!unattendedAllowed(database)) {
		return 'This server stopped letting AI run saved commands without approval.';
	}
	return machinesInGroups(database, command.machineGroupIds).has(machineId)
		? undefined
		: "The machine left the saved command's machine groups before its turn.";
}
