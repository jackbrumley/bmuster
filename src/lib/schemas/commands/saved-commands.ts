/**
 * Saved commands requests and replies (SPEC-SAVED-COMMANDS 5). The admin's form and the server
 * check a saved command with the same schema (SC2, SC3), and a run's values with the same rules.
 */
import { z } from 'zod';
import { hasBidiControls } from '#lib/domain/commands/assistant-runs.ts';
import { COMMAND_LIMITS, COMMAND_SHELLS } from '#lib/domain/commands/commands.ts';
import {
	CHOICE_VALUE,
	PARAMETER_NAME,
	SAVED_COMMAND_LIMITS,
	SAVED_EFFECTS,
	TEXT_PATTERNS,
	type SavedParameter,
	type SavedScript
} from '#lib/domain/commands/saved-commands.ts';
import { recheckSchema } from '../auth/recheck.ts';
import { commandScriptSchema, planReplySchema } from './commands.ts';

const LIMITS = SAVED_COMMAND_LIMITS;

const script = z
	.string()
	.refine((text) => text.trim().length > 0, 'Write the script first.')
	.refine(
		(text) => text.length <= LIMITS.maxScriptChars,
		`A script is at most ${LIMITS.maxScriptChars.toLocaleString('en-AU')} characters.`
	)
	.refine((text) => !text.includes('\0'), 'A script cannot contain a NUL character.')
	.refine(
		(text) => !hasBidiControls(text),
		'A script cannot contain text-direction control characters.'
	);

export const savedScriptSchema: z.ZodType<SavedScript> = z.discriminatedUnion('osFamily', [
	z.object({ osFamily: z.literal('windows'), shell: z.enum(COMMAND_SHELLS.windows), script }),
	z.object({ osFamily: z.literal('linux'), shell: z.enum(COMMAND_SHELLS.linux), script })
]);

const label = z
	.string()
	.trim()
	.min(1, 'Give the parameter a label.')
	.max(LIMITS.maxLabelChars, `A label is at most ${String(LIMITS.maxLabelChars)} characters.`);

const name = z
	.string()
	.regex(
		PARAMETER_NAME,
		'A parameter name is lower-case letters, digits and _, starting with a letter, up to 32.'
	);

const bound = z.int().min(LIMITS.minNumber).max(LIMITS.maxNumber);

export const savedParameterSchema: z.ZodType<SavedParameter> = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('number'), name, label, min: bound, max: bound }),
	z.object({
		kind: z.literal('choice'),
		name,
		label,
		choices: z
			.array(
				z
					.string()
					.regex(
						CHOICE_VALUE,
						'A choice is letters, digits, spaces and _ . : @ / \\ + -, up to 128.'
					)
			)
			.min(1, 'Give at least one choice.')
			.max(LIMITS.maxChoices, `At most ${String(LIMITS.maxChoices)} choices.`)
			.refine((list) => new Set(list).size === list.length, 'A choice is listed twice.')
	}),
	z.object({ kind: z.literal('text'), name, label, pattern: z.enum(TEXT_PATTERNS) })
]);

/** A saved command as an admin writes it (SC2, SC3). */
export const savedCommandFieldsSchema = z
	.object({
		name: z
			.string()
			.trim()
			.min(1, 'Give it a name.')
			.max(LIMITS.maxNameChars, `A name is at most ${String(LIMITS.maxNameChars)} characters.`),
		description: z
			.string()
			.trim()
			.min(1, 'Say what it does.')
			.max(
				LIMITS.maxDescriptionChars,
				`A description is at most ${String(LIMITS.maxDescriptionChars)} characters.`
			),
		scripts: z
			.array(savedScriptSchema)
			.min(1, 'Write a script for at least one system.')
			.refine(
				(list) => new Set(list.map((entry) => entry.osFamily)).size === list.length,
				'Write one script per system.'
			),
		machineGroupIds: z
			.array(z.uuid())
			.min(1, 'Choose at least one machine group.')
			.refine((ids) => new Set(ids).size === ids.length, 'A group is listed twice.'),
		parameters: z
			.array(savedParameterSchema)
			.max(LIMITS.maxParameters, `At most ${String(LIMITS.maxParameters)} parameters.`),
		effect: z.enum(SAVED_EFFECTS),
		enabled: z.boolean(),
		aiUnattended: z.boolean(),
		timeoutMs: z
			.int()
			.min(COMMAND_LIMITS.minTimeoutMs, 'The time limit is at least 5 seconds.')
			.max(COMMAND_LIMITS.maxTimeoutMs, 'The time limit is at most 10 minutes.')
	})
	.superRefine((command, context) => {
		const names = command.parameters.map((parameter) => parameter.name);
		if (new Set(names).size !== names.length) {
			context.addIssue({
				code: 'custom',
				message: 'Two parameters have the same name.',
				path: ['parameters']
			});
		}
		for (const [index, parameter] of command.parameters.entries()) {
			if (parameter.kind === 'number' && parameter.min > parameter.max) {
				context.addIssue({
					code: 'custom',
					message: `${parameter.label}: the smallest is more than the largest.`,
					path: ['parameters', index]
				});
			}
		}
		if (command.parameters.length > 0 && command.scripts.some((entry) => entry.shell === 'cmd')) {
			context.addIssue({
				code: 'custom',
				message:
					'A Windows script with parameters must be PowerShell: cmd cannot read them safely.',
				path: ['scripts']
			});
		}
	});

export type SavedCommandFields = z.infer<typeof savedCommandFieldsSchema>;

/** POST /api/commands/saved and PUT /api/commands/saved/<id> (SC4): the command and the recheck. */
export const savedCommandWriteSchema = z.object({
	command: savedCommandFieldsSchema,
	recheck: recheckSchema
});

export type SavedCommandWrite = z.infer<typeof savedCommandWriteSchema>;

/** DELETE /api/commands/saved/<id> (SC4). */
export const savedCommandDeleteSchema = z.object({ recheck: recheckSchema });

export const savedCommandWrittenSchema = z.object({ id: z.uuid(), version: z.int() });

export const savedCommandDeletedSchema = z.object({ deleted: z.literal(true) });

/** A run's values, by parameter name: checked against the parameters on the server (SC12). */
const parameterValuesSchema = z.record(
	z.string().max(32),
	z.union([z.string().max(300), z.number()])
);

const machineIds = z
	.array(z.uuid())
	.min(1, 'Pick at least one machine.')
	.max(5000, 'A run has at most 5000 machines.')
	.refine((ids) => new Set(ids).size === ids.length, 'A machine is listed twice.');

/** POST /api/commands/saved/<id>/plan: what Review shows (SC11). */
export const savedPlanRequestSchema = z.object({
	version: z.int().min(1),
	machineIds,
	values: parameterValuesSchema
});

export const savedPlanReplySchema = planReplySchema.extend({
	commands: z.array(commandScriptSchema)
});

/** POST /api/commands/saved/<id>/runs (SC12). */
export const savedRunRequestSchema = savedPlanRequestSchema.extend({
	confirmCount: z.int().min(0),
	recheck: recheckSchema
});

export type SavedRunRequest = z.infer<typeof savedRunRequestSchema>;

/** GET /api/commands/saved (SC1, SC9): the saved commands, each with the machines the person may run it on. */
export const savedCommandListSchema = z.object({
	commands: z.array(
		z.object({
			id: z.uuid(),
			name: z.string(),
			description: z.string(),
			effect: z.enum(SAVED_EFFECTS),
			systems: z.array(z.enum(['windows', 'linux'])),
			enabled: z.boolean(),
			aiUnattended: z.boolean(),
			version: z.int(),
			machineIds: z.array(z.uuid())
		})
	)
});

/** What a saved command's run screen opens with from Machines (SC9): the machines ticked. */
export const savedRunDraftSchema = z.object({ machineIds: z.array(z.uuid()) });
