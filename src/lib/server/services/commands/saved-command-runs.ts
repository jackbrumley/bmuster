import {
	commandOsLabel,
	type CommandOsFamily,
	type CommandScript,
	type PlannedMachine
} from '#lib/domain/commands/commands.ts';
import type { SignInCheck } from '#lib/domain/auth/sign-in-check.ts';
import {
	composeCommand,
	parameterValueProblem,
	type ParameterValues,
	type SavedCommandEntry,
	type SavedCommandView,
	type SavedRunMachine
} from '#lib/domain/commands/saved-commands.ts';
import type { ConsoleUser } from '#lib/domain/users/user.ts';
import { commandScriptSchema } from '#lib/schemas/commands/commands.ts';
import type { SavedRunRequest } from '#lib/schemas/commands/saved-commands.ts';
import type { Queryable } from '../../database/connection.ts';
import { machineIdsWith } from '../access/access.ts';
import { listMachineGroups } from '../access/groups.ts';
import { activeMachineNames, machineAgentFacts } from '../machines/machine-views.ts';
import {
	beginPersonRun,
	checkRecentSignIn,
	forbiddenRefusal,
	planRun,
	skipReasonOf,
	visibleMachines,
	type CommandContext,
	type MachineFacts,
	type Refused
} from './commands.ts';
import { allSavedCommands, findSavedCommand } from './saved-commands.ts';

/**
 * People running a saved command (SPEC-SAVED-COMMANDS SC9–SC13), and the checks an assistant's
 * request shares with them: the command switched on and at the version reviewed, every machine in
 * its groups with a script for its system, every value of its type. The values reach the script
 * only as environment variables, set by the prelude `composeCommand` writes (SC13).
 */

/** The machines in any of these groups; All machines holds every machine. Removed ones are left out. */
export function machinesInGroups(database: Queryable, groupIds: readonly string[]): Set<string> {
	const wanted = new Set(groupIds);
	const groups = listMachineGroups(database).filter((group) => wanted.has(group.id));
	if (groups.some((group) => group.membership.kind === 'all-machines')) {
		return new Set(activeMachineNames(database).keys());
	}
	return new Set(
		groups.flatMap((group) =>
			group.membership.kind === 'chosen' ? group.membership.machineIds : []
		)
	);
}

function entryOf(
	database: Queryable,
	user: ConsoleUser,
	command: SavedCommandView
): SavedCommandEntry {
	return {
		machineIds: savedRunMachines(database, user, command).map((machine) => machine.id),
		id: command.id,
		name: command.name,
		description: command.description,
		effect: command.effect,
		systems: command.systems,
		enabled: command.enabled,
		aiUnattended: command.aiUnattended,
		version: command.version
	};
}

/**
 * The machines this person may run the command on (SC10): in its groups, with `run-commands`,
 * on a system it has a script for. By name.
 */
export function savedRunMachines(
	database: Queryable,
	user: ConsoleUser,
	command: SavedCommandView
): SavedRunMachine[] {
	const inGroups = machinesInGroups(database, command.machineGroupIds);
	const runnable = [...machineIdsWith(database, user, 'run-commands')].filter((id) =>
		inGroups.has(id)
	);
	const facts = machineAgentFacts(database, runnable);
	return runnable
		.flatMap((id): SavedRunMachine[] => {
			const machine = facts.get(id);
			if (machine === undefined || machine.osFamily === 'macos') {
				return [];
			}
			const osFamily: CommandOsFamily = machine.osFamily;
			return command.systems.includes(osFamily) ? [{ id, name: machine.name, osFamily }] : [];
		})
		.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Saved commands on the Saved commands tab (SC1): every one for an admin; for anyone else the
 * switched-on ones they could run somewhere.
 */
export function savedCommandsFor(database: Queryable, user: ConsoleUser): SavedCommandEntry[] {
	const entries = allSavedCommands(database).map((command) => entryOf(database, user, command));
	return canWriteSavedCommands(user)
		? entries
		: entries.filter((entry) => entry.enabled && entry.machineIds.length > 0);
}

/** Admins write saved commands and see every one, switched off or not (SC1, SC4). */
export function canWriteSavedCommands(user: ConsoleUser): boolean {
	switch (user.role) {
		case 'admin':
			return true;
		case 'member':
			return false;
	}
}

const NOT_FOUND: Refused = {
	kind: 'refused',
	status: 404,
	message: 'No saved command with this id.'
};

/** A switched-on saved command, for a run screen (SC10); switched off looks missing. */
export function runnableSavedCommand(
	database: Queryable,
	id: string
): SavedCommandView | undefined {
	const command = findSavedCommand(database, id);
	return command?.enabled === true ? command : undefined;
}

/** Checks each value against its parameter; any other name is refused (SC3, SC12). */
export function checkValues(
	command: SavedCommandView,
	values: ParameterValues
): { kind: 'ok'; values: ParameterValues } | { kind: 'refused'; message: string } {
	const known = new Set(command.parameters.map((parameter) => parameter.name));
	const unknown = Object.keys(values).find((name) => !known.has(name));
	if (unknown !== undefined) {
		return { kind: 'refused', message: `${command.name} has no parameter called ${unknown}.` };
	}
	const checked: ParameterValues = {};
	for (const parameter of command.parameters) {
		const value = values[parameter.name];
		const problem = parameterValueProblem(parameter, value);
		if (problem !== undefined || value === undefined) {
			return { kind: 'refused', message: problem ?? `Fill in ${parameter.label}.` };
		}
		checked[parameter.name] = parameter.kind === 'number' ? Number(value) : String(value);
	}
	return { kind: 'ok', values: checked };
}

/**
 * The exact command for each system among these machines (SC13): the prelude with the values,
 * then the admin's script, checked against the Commands limits (C7).
 */
export function composedScripts(
	command: SavedCommandView,
	systems: readonly CommandOsFamily[],
	values: ParameterValues
): { kind: 'ok'; scripts: CommandScript[] } | { kind: 'refused'; message: string } {
	const scripts: CommandScript[] = [];
	for (const script of command.scripts.filter((entry) => systems.includes(entry.osFamily))) {
		const parsed = commandScriptSchema.safeParse({
			osFamily: script.osFamily,
			shell: script.shell,
			command: composeCommand(script, command.parameters, values)
		});
		if (!parsed.success) {
			return {
				kind: 'refused',
				message: parsed.error.issues[0]?.message ?? 'The command is not valid.'
			};
		}
		scripts.push(parsed.data);
	}
	return { kind: 'ok', scripts };
}

/**
 * Why a machine cannot take this command at all, or undefined: outside its groups, macOS, or a
 * system it has no script for (SC12, SC16). Refused whole, never trimmed.
 */
export function placeProblem(
	command: SavedCommandView,
	inGroups: ReadonlySet<string>,
	machine: { id: string; name: string; osFamily: MachineFacts['osFamily'] }
): string | undefined {
	if (!inGroups.has(machine.id)) {
		return `${machine.name} is not in a machine group ${command.name} may run on.`;
	}
	if (machine.osFamily === 'macos') {
		return `${machine.name} runs macOS. Commands run on Windows and Linux only.`;
	}
	const family: CommandOsFamily = machine.osFamily;
	return command.systems.includes(family)
		? undefined
		: `${command.name} has no ${commandOsLabel(family)} script, so it cannot run on ${machine.name}.`;
}

type Selection = {
	command: SavedCommandView;
	machines: MachineFacts[];
	scripts: CommandScript[];
	values: ParameterValues;
};

/** Everything a person's plan and run check before Review or the run (SC12). */
function checkSelection(
	context: Pick<CommandContext, 'database' | 'user'>,
	id: string,
	request: { version: number; machineIds: string[]; values: ParameterValues }
): { kind: 'ok'; selection: Selection } | Refused {
	const command = runnableSavedCommand(context.database, id);
	if (command === undefined) {
		return NOT_FOUND;
	}
	if (command.version !== request.version) {
		return {
			kind: 'refused',
			status: 409,
			message: `${command.name} was changed since you opened it. Open it again and review it.`
		};
	}
	const found = visibleMachines(context, request.machineIds);
	if (found.kind === 'refused') {
		return found;
	}
	const inGroups = machinesInGroups(context.database, command.machineGroupIds);
	for (const machine of found.machines) {
		const problem = placeProblem(command, inGroups, machine);
		if (problem !== undefined) {
			return { kind: 'refused', status: 400, message: problem };
		}
	}
	const values = checkValues(command, request.values);
	if (values.kind === 'refused') {
		return { kind: 'refused', status: 400, message: values.message };
	}
	const systems = [
		...new Set(
			found.machines.flatMap((machine) => (machine.osFamily === 'macos' ? [] : [machine.osFamily]))
		)
	];
	const scripts = composedScripts(command, systems, values.values);
	if (scripts.kind === 'refused') {
		return { kind: 'refused', status: 400, message: scripts.message };
	}
	return {
		kind: 'ok',
		selection: {
			command,
			machines: found.machines,
			scripts: scripts.scripts,
			values: values.values
		}
	};
}

/** What Review shows (SC11): the exact commands, the machines, whether a password is needed. */
export function planSavedRun(
	context: Pick<CommandContext, 'database' | 'user' | 'sessionToken' | 'now'>,
	id: string,
	request: { version: number; machineIds: string[]; values: ParameterValues }
):
	| { kind: 'planned'; commands: CommandScript[]; machines: PlannedMachine[]; signIn: SignInCheck }
	| Refused {
	const checked = checkSelection(context, id, request);
	if (checked.kind === 'refused') {
		return checked;
	}
	const planned = planRun(context, request.machineIds);
	return planned.kind === 'refused' ? planned : { ...planned, commands: checked.selection.scripts };
}

/**
 * Starts a person's run of a saved command (SC12): every check again, the count, the recent
 * sign-in, then an ordinary Commands run marked with the saved command and its version.
 */
export async function startSavedRun(
	context: CommandContext,
	id: string,
	request: SavedRunRequest
): Promise<{ kind: 'started'; runId: string } | Refused> {
	const checked = checkSelection(context, id, request);
	if (checked.kind === 'refused') {
		return checked;
	}
	const { command, scripts, values } = checked.selection;
	const machines = checked.selection.machines.map((machine) => ({
		machine,
		reason: skipReasonOf(context, machine)
	}));
	const forbidden = forbiddenRefusal(machines);
	if (forbidden !== undefined) {
		return forbidden;
	}
	if (request.confirmCount !== request.machineIds.length) {
		return {
			kind: 'refused',
			status: 400,
			message: `Type ${String(request.machineIds.length)}, the number of machines, to confirm.`
		};
	}
	const signIn = await checkRecentSignIn(context, request.recheck);
	if (signIn !== undefined) {
		return signIn;
	}
	return beginPersonRun(context, {
		machines,
		scripts,
		timeoutMs: command.timeoutMs,
		rerunOf: null,
		saved: {
			kind: 'saved',
			id: command.id,
			name: command.name,
			version: command.version,
			effect: command.effect,
			values
		}
	});
}
