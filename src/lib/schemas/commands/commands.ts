/**
 * Commands requests and replies (SPEC-COMMANDS 5). The Run command form and the server check
 * a request with the same schema (C7).
 */
import { z } from 'zod';
import {
	COMMAND_LIMITS,
	COMMAND_SHELLS,
	RUN_MACHINE_STATUSES,
	RUN_STATUSES,
	type CommandDraft,
	type PlannedMachine,
	type RunCounts,
	type RunMachineOutput,
	type RunView
} from '#lib/domain/commands/commands.ts';
import type { SignInCheck } from '#lib/domain/auth/sign-in-check.ts';

/** The event name on GET /api/commands/runs/<id>/events. */
export const COMMAND_RUN_EVENT = 'command-run';

/** At most this many machines in one run. */
const MAX_MACHINES = 5000;

const command = z
	.string()
	.refine((text) => text.trim().length > 0, 'Write a command first.')
	.refine(
		(text) => text.length <= COMMAND_LIMITS.maxCommandChars,
		`A command is at most ${COMMAND_LIMITS.maxCommandChars.toLocaleString('en-AU')} characters.`
	)
	.refine((text) => !text.includes('\0'), 'A command cannot contain a NUL character.');

/** One system's command and shell (C6, C7). */
export const commandScriptSchema = z.discriminatedUnion('osFamily', [
	z.object({
		osFamily: z.literal('windows'),
		shell: z.enum(COMMAND_SHELLS.windows),
		command
	}),
	z.object({ osFamily: z.literal('linux'), shell: z.enum(COMMAND_SHELLS.linux), command })
]);

const machineIds = z
	.array(z.uuid())
	.min(1, 'Pick at least one machine.')
	.max(MAX_MACHINES, `A run has at most ${MAX_MACHINES} machines.`)
	.refine((ids) => new Set(ids).size === ids.length, 'A machine is listed twice.');

const timeoutMs = z
	.int()
	.min(COMMAND_LIMITS.minTimeoutMs, 'The time limit is at least 5 seconds.')
	.max(COMMAND_LIMITS.maxTimeoutMs, 'The time limit is at most 10 minutes.');

const scripts = z
	.array(commandScriptSchema)
	.min(1, 'Write a command first.')
	.refine(
		(list) => new Set(list.map((script) => script.osFamily)).size === list.length,
		'Write one command per system.'
	);

/** POST /api/commands/plan: what Review shows for these machines (C8, C10). */
export const planRequestSchema = z.object({ machineIds });

const plannedMachineSchema: z.ZodType<PlannedMachine> = z.object({
	id: z.uuid(),
	name: z.string(),
	osFamily: z.enum(['windows', 'linux', 'macos']),
	plan: z.discriminatedUnion('kind', [
		z.object({ kind: z.literal('runs') }),
		z.object({
			kind: z.literal('skipped'),
			reason: z.enum(['offline', 'agent-too-old', 'unsupported-system', 'no-permission'])
		})
	])
});

const signInCheckSchema: z.ZodType<SignInCheck> = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('recent') }),
	z.object({ kind: z.literal('password') }),
	z.object({ kind: z.literal('sign-in-again') })
]);

export const planReplySchema = z.object({
	machines: z.array(plannedMachineSchema),
	signIn: signInCheckSchema
});

/**
 * POST /api/commands/runs (C7–C12). `confirmCount` is the number typed in the confirmation
 * (the machine count when 10 or fewer); `password` when the last check is too old (C10).
 */
export const startRunRequestSchema = z.object({
	machineIds,
	scripts,
	timeoutMs,
	confirmCount: z.int().min(0),
	password: z.discriminatedUnion('kind', [
		z.object({ kind: z.literal('none') }),
		z.object({ kind: z.literal('given'), password: z.string().min(1).max(1024) })
	]),
	rerunOf: z.uuid().nullable()
});

export type StartRunRequest = z.infer<typeof startRunRequestSchema>;

export const startRunReplySchema = z.object({ runId: z.uuid() });

const countsSchema: z.ZodType<RunCounts> = z.object({
	waiting: z.int(),
	running: z.int(),
	succeeded: z.int(),
	failed: z.int(),
	'timed-out': z.int(),
	offline: z.int(),
	skipped: z.int(),
	lost: z.int(),
	cancelled: z.int()
});

export const runViewSchema: z.ZodType<RunView> = z.object({
	id: z.uuid(),
	startedBy: z.string(),
	startedIso: z.iso.datetime(),
	endedIso: z.iso.datetime().nullable(),
	status: z.enum(RUN_STATUSES),
	timeoutMs: z.int(),
	scripts: z.array(commandScriptSchema),
	machines: z.array(
		z.object({
			machineId: z.uuid(),
			machineName: z.string(),
			status: z.enum(RUN_MACHINE_STATUSES),
			reason: z.string(),
			exitCode: z.int().nullable(),
			durationMs: z.int().nullable(),
			output: z.discriminatedUnion('kind', [
				z.object({ kind: z.literal('none') }),
				z.object({ kind: z.literal('kept'), bytes: z.int() }),
				z.object({ kind: z.literal('deleted') })
			])
		})
	),
	counts: countsSchema,
	canCancel: z.boolean()
});

export const runOutputReplySchema: z.ZodType<RunMachineOutput> = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('none') }),
	z.object({ kind: z.literal('deleted') }),
	z.object({
		kind: z.literal('kept'),
		stdout: z.string(),
		stderr: z.string(),
		stdoutTruncated: z.boolean(),
		stderrTruncated: z.boolean()
	})
]);

export const cancelRunReplySchema = z.object({ cancelled: z.int().min(0) });

/** What **Run command** opens with, carried in page state from Machines or a results page. */
export const commandDraftSchema: z.ZodType<CommandDraft> = z.object({
	machineIds,
	scripts: z.array(commandScriptSchema),
	timeoutMs,
	rerunOf: z.uuid().nullable()
});
