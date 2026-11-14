import { z } from 'zod';

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
