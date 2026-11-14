import { z } from 'zod';
import { ASSISTANT_RUN_LIMITS } from '#lib/domain/commands/assistant-runs.ts';
import {
	COMMAND_LIMITS,
	RUN_MACHINE_STATUSES,
	RUN_STATUSES
} from '#lib/domain/commands/commands.ts';

/**
 * The MCP tools' contracts (SPEC-MCP 9). The output schemas are the whole of what an assistant
 * can learn about a machine (M12): no field could carry a join code, local page code, secret,
 * key, ticket, share-link or OAuth token, machine note, or anyone's email address.
 */

const os = z.enum(['windows', 'linux', 'macos']);
const status = z.enum(['online', 'reconnecting', 'offline']);

export const listMachinesInput = z.object({
	search: z
		.string()
		.max(100)
		.default('')
		.describe('Part of a machine name or host name; leave out to list every machine.'),
	status: z.enum(['online', 'offline', 'any']).default('any'),
	limit: z.int().min(1).max(200).default(50)
});

const machineSummary = z.object({
	id: z.string(),
	name: z.string(),
	hostname: z.string(),
	os,
	osVersion: z.string(),
	status,
	lastSeenAt: z.string(),
	shells: z.array(z.string()),
	groups: z.array(z.string())
});

export const listMachinesOutput = z.object({
	machines: z.array(machineSummary),
	total: z.int()
});

export type ListMachinesOutput = z.infer<typeof listMachinesOutput>;

export const getMachineInput = z.object({
	machine: z
		.string()
		.min(1)
		.max(200)
		.describe("The machine's id, or its name when no other machine you can see has that name.")
});

export const getMachineOutput = z.object({
	id: z.string(),
	name: z.string(),
	hostname: z.string(),
	os,
	osVersion: z.string(),
	kernel: z.string(),
	architecture: z.string(),
	status,
	lastSeenAt: z.string(),
	uptimeSeconds: z.number().nullable(),
	cpuPercent: z.number().nullable(),
	memory: z.object({ totalBytes: z.number().nullable(), usedPercent: z.number().nullable() }),
	disks: z.array(z.object({ mount: z.string(), totalBytes: z.number(), freeBytes: z.number() })),
	lastUser: z.string().nullable(),
	agentVersion: z.string(),
	shells: z.array(z.string()),
	groups: z.array(z.string()),
	inUse: z.array(z.object({ kind: z.string(), by: z.string() })),
	recentActivity: z.array(z.object({ at: z.string(), summary: z.string() }))
});

export type GetMachineOutput = z.infer<typeof getMachineOutput>;

/** Step 2 (SPEC-MCP 9.3–9.5): commands, each held for a person's approval. */

export const runCommandInput = z.object({
	machines: z
		.array(z.string().min(1).max(200))
		.min(1)
		.max(ASSISTANT_RUN_LIMITS.maxMachines)
		.describe(
			'1 to 10 machines, each by id or by a name no other machine you can see has. All on the same system as the shell.'
		),
	shell: z
		.enum(['powershell', 'cmd', 'sh', 'bash'])
		.describe('powershell or cmd for Windows machines; sh or bash for Linux machines.'),
	command: z
		.string()
		.min(1)
		.max(COMMAND_LIMITS.maxCommandChars)
		.describe('The exact command. It runs with no input, so nothing interactive.'),
	timeoutSeconds: z
		.int()
		.min(ASSISTANT_RUN_LIMITS.minTimeoutSeconds)
		.max(ASSISTANT_RUN_LIMITS.maxTimeoutSeconds)
		.default(ASSISTANT_RUN_LIMITS.defaultTimeoutSeconds),
	reason: z
		.string()
		.min(1)
		.max(ASSISTANT_RUN_LIMITS.maxReasonChars)
		.describe('Why you want to run it, in a sentence. The person approving reads this.')
});

export const getCommandResultInput = z.object({
	runId: z.uuid().describe('The runId run_command returned.'),
	waitSeconds: z
		.int()
		.min(0)
		.max(ASSISTANT_RUN_LIMITS.maxWaitSeconds)
		.default(ASSISTANT_RUN_LIMITS.maxWaitSeconds)
		.describe('How long to wait for the run to end before answering with where it is up to.'),
	machine: z
		.string()
		.max(200)
		.default('')
		.describe("Whose output to return: a machine's id or name. Leave out for the first machine."),
	stdoutOffset: z.int().min(0).default(0).describe('Byte offset to read stdout from.'),
	stderrOffset: z.int().min(0).default(0).describe('Byte offset to read stderr from.')
});

export const cancelCommandInput = z.object({ runId: z.uuid() });

const runStatus = z.enum(RUN_STATUSES);

const streamPage = z.object({
	text: z.string(),
	offset: z.int(),
	nextOffset: z.int(),
	totalBytes: z.int(),
	more: z.boolean()
});

export const commandResultOutput = z.object({
	runId: z.string(),
	status: runStatus,
	message: z.string(),
	approvalUrl: z.string(),
	expiresAt: z.string().nullable(),
	decidedBy: z.string().nullable(),
	denyNote: z.string().nullable(),
	edited: z.boolean(),
	commandRun: z.string().nullable(),
	machines: z.array(
		z.object({
			id: z.string(),
			name: z.string(),
			status: z.enum(RUN_MACHINE_STATUSES),
			reason: z.string(),
			exitCode: z.int().nullable(),
			durationMs: z.int().nullable()
		})
	),
	output: z
		.object({
			machine: z.string(),
			stdout: streamPage,
			stderr: streamPage,
			stdoutTruncated: z.boolean(),
			stderrTruncated: z.boolean(),
			deleted: z.boolean()
		})
		.nullable()
});

export type CommandResultOutput = z.infer<typeof commandResultOutput>;

export const cancelCommandOutput = z.object({
	runId: z.string(),
	status: runStatus,
	message: z.string()
});

export type CancelCommandOutput = z.infer<typeof cancelCommandOutput>;
