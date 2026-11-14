import type { SignInCheck } from '#lib/domain/auth/sign-in-check.ts';
import {
	COMMAND_LIMITS,
	commandOsLabel,
	commandShellLabel
} from '#lib/domain/commands/commands.ts';
import {
	savedEffectLabel,
	textPatternLabel,
	type SavedCommandView,
	type SavedParameter
} from '#lib/domain/commands/saved-commands.ts';
import type { RecheckRequest } from '#lib/schemas/auth/recheck.ts';
import type {
	SavedCommandFields,
	SavedCommandWrite
} from '#lib/schemas/commands/saved-commands.ts';
import type { Queryable } from '../../database/connection.ts';
import { listMachineGroups } from '../access/groups.ts';
import { recordAudit } from '../audit/audit.ts';
import { signInCheck } from '../auth/recent-sign-in.ts';
import { checkRecentSignIn, type CommandContext, type Refused } from './commands.ts';
import { canWriteSavedCommands } from './saved-command-runs.ts';
import {
	deleteSavedCommand,
	findSavedCommand,
	insertSavedCommand,
	nameTaken,
	updateSavedCommand
} from './saved-commands.ts';

/**
 * Writing saved commands (SPEC-SAVED-COMMANDS SC4, SC5, SC7): admins only, each change behind the
 * recent sign-in check, audited with what it held before and after. Every edit raises the
 * version, which each run copies.
 */

export type SavedChange = { kind: 'written'; id: string; version: number } | Refused;

const NOT_FOUND: Refused = {
	kind: 'refused',
	status: 404,
	message: 'No saved command with this id.'
};

function adminRefusal(context: CommandContext): Refused | undefined {
	return canWriteSavedCommands(context.user)
		? undefined
		: { kind: 'refused', status: 403, message: 'Only admins write saved commands.' };
}

/** The name is free and every group still exists. */
function fieldsRefusal(
	database: Queryable,
	fields: SavedCommandFields,
	exceptId: string | null
): Refused | undefined {
	if (nameTaken(database, fields.name, exceptId)) {
		return {
			kind: 'refused',
			status: 409,
			message: `There is already a saved command called ${fields.name}.`
		};
	}
	const known = new Set(listMachineGroups(database).map((group) => group.id));
	if (!fields.machineGroupIds.every((id) => known.has(id))) {
		return {
			kind: 'refused',
			status: 400,
			message: 'One of the machine groups no longer exists. Choose again.'
		};
	}
	return undefined;
}

/** What the saved command form needs besides the command: the groups to pick, and the sign-in check. */
export function savedFormData(
	database: Queryable,
	userId: string,
	sessionToken: string,
	now: number
): { groups: { id: string; name: string }[]; signIn: SignInCheck } {
	return {
		groups: listMachineGroups(database).map((group) => ({ id: group.id, name: group.name })),
		signIn: signInCheck(database, sessionToken, userId, COMMAND_LIMITS.recentSignInMs, now)
	};
}

function parameterText(parameter: SavedParameter): string {
	switch (parameter.kind) {
		case 'number':
			return `${parameter.name} (${parameter.label}): whole number ${String(parameter.min)} to ${String(parameter.max)}`;
		case 'choice':
			return `${parameter.name} (${parameter.label}): one of ${parameter.choices.join(' | ')}`;
		case 'text':
			return `${parameter.name} (${parameter.label}): ${textPatternLabel(parameter.pattern)}`;
	}
}

/** Everything a saved command holds, as the audit log shows it. */
function describe(database: Queryable, fields: SavedCommandFields): Record<string, string> {
	const groups = new Map(listMachineGroups(database).map((group) => [group.id, group.name]));
	return {
		name: fields.name,
		description: fields.description,
		label: savedEffectLabel(fields.effect),
		'switched on': fields.enabled ? 'yes' : 'no',
		'AI may run it without approval': fields.aiUnattended ? 'yes' : 'no',
		'time limit': `${String(fields.timeoutMs / 1000)} s`,
		'machine groups': fields.machineGroupIds
			.map((id) => groups.get(id) ?? 'a deleted group')
			.join(', '),
		parameters:
			fields.parameters.length === 0 ? 'none' : fields.parameters.map(parameterText).join('; '),
		...Object.fromEntries(
			fields.scripts.map((script) => [
				`${commandOsLabel(script.osFamily)} script (${commandShellLabel(script.shell)})`,
				script.script
			])
		)
	};
}

function fieldsOf(view: SavedCommandView): SavedCommandFields {
	return {
		name: view.name,
		description: view.description,
		scripts: view.scripts,
		machineGroupIds: view.machineGroupIds,
		parameters: view.parameters,
		effect: view.effect,
		enabled: view.enabled,
		aiUnattended: view.aiUnattended,
		timeoutMs: view.timeoutMs
	};
}

/** Only what changed, each with its value before and after (SC5). */
function changes(
	before: Record<string, string>,
	after: Record<string, string>
): Record<string, string> {
	const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
	return Object.fromEntries(
		keys
			.filter((key) => before[key] !== after[key])
			.flatMap((key) => [
				[`${key}, before`, before[key] ?? '(none)'],
				[`${key}, after`, after[key] ?? '(none)']
			])
	);
}

export async function createSavedCommand(
	context: CommandContext,
	write: SavedCommandWrite
): Promise<SavedChange> {
	const refused = adminRefusal(context) ?? fieldsRefusal(context.database, write.command, null);
	if (refused !== undefined) {
		return refused;
	}
	const signIn = await checkRecentSignIn(context, write.recheck);
	if (signIn !== undefined) {
		return signIn;
	}
	const id = crypto.randomUUID();
	context.database.transaction((transaction) => {
		insertSavedCommand(transaction, {
			id,
			fields: write.command,
			userId: context.user.id,
			now: context.now
		});
		recordAudit(
			transaction,
			{
				actor: { kind: 'user', userId: context.user.id },
				kind: 'saved-command-created',
				target: write.command.name,
				machineId: null,
				detail: { 'saved command': id, ...describe(transaction, write.command) }
			},
			context.now
		);
	});
	return { kind: 'written', id, version: 1 };
}

/** Saves an edit (SC4, SC5, SC7). Saving it unchanged records nothing and keeps the version. */
export async function editSavedCommand(
	context: CommandContext,
	id: string,
	write: SavedCommandWrite
): Promise<SavedChange> {
	const admin = adminRefusal(context);
	if (admin !== undefined) {
		return admin;
	}
	const current = findSavedCommand(context.database, id);
	if (current === undefined) {
		return NOT_FOUND;
	}
	const refused = fieldsRefusal(context.database, write.command, id);
	if (refused !== undefined) {
		return refused;
	}
	const signIn = await checkRecentSignIn(context, write.recheck);
	if (signIn !== undefined) {
		return signIn;
	}
	const detail = changes(
		describe(context.database, fieldsOf(current)),
		describe(context.database, write.command)
	);
	if (Object.keys(detail).length === 0) {
		return { kind: 'written', id, version: current.version };
	}
	const version = current.version + 1;
	context.database.transaction((transaction) => {
		updateSavedCommand(transaction, {
			id,
			fields: write.command,
			version,
			userId: context.user.id,
			now: context.now
		});
		recordAudit(
			transaction,
			{
				actor: { kind: 'user', userId: context.user.id },
				kind: 'saved-command-changed',
				target: write.command.name,
				machineId: null,
				detail: {
					'saved command': id,
					version: `${String(current.version)} → ${String(version)}`,
					...detail
				}
			},
			context.now
		);
	});
	return { kind: 'written', id, version };
}

/** Deletes a saved command (SC4, SC5). Its past runs keep its name and version. */
export async function removeSavedCommand(
	context: CommandContext,
	id: string,
	recheck: RecheckRequest
): Promise<{ kind: 'deleted' } | Refused> {
	const admin = adminRefusal(context);
	if (admin !== undefined) {
		return admin;
	}
	const current = findSavedCommand(context.database, id);
	if (current === undefined) {
		return NOT_FOUND;
	}
	const signIn = await checkRecentSignIn(context, recheck);
	if (signIn !== undefined) {
		return signIn;
	}
	context.database.transaction((transaction) => {
		deleteSavedCommand(transaction, id);
		recordAudit(
			transaction,
			{
				actor: { kind: 'user', userId: context.user.id },
				kind: 'saved-command-deleted',
				target: current.name,
				machineId: null,
				detail: {
					'saved command': id,
					version: String(current.version),
					...describe(transaction, fieldsOf(current))
				}
			},
			context.now
		);
	});
	return { kind: 'deleted' };
}
