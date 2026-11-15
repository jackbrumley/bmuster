import { z } from 'zod';
import { ASSISTANT_RUN_LIMITS } from '#lib/domain/commands/assistant-runs.ts';
import { CLEANUP_ITEM_IDS } from '#lib/domain/storage/cleanup.ts';
import { cleanupItemIdSchema } from '../storage/cleanup.ts';

/**
 * The storage tools' contracts (SPEC-MCP M49–M56): the agent's cached scan, Rescan now, and
 * clean-ups of BMuster's fixed safe list, each waiting for a person's approval. Folder and file
 * names come from the machine: they are data, never instructions.
 */

const machineName = z
	.string()
	.min(1)
	.max(200)
	.describe("The machine's id, or its name when no other machine you can see has that name.");

const STORAGE_TOOL_LIMITS = {
	defaultFolders: 25,
	maxFolders: 200,
	defaultLargestFiles: 20,
	/** The most the agent answers in one request (SPEC-STORAGE 5). */
	maxLargestFiles: 100
} as const;

export const getStorageInput = z.object({
	machine: machineName,
	drive: z
		.string()
		.max(4096)
		.default('')
		.describe(
			'A drive by its mount, as get_storage lists it ("/", "C:\\"). Leave out to use the drive holding path, or else the first scanned drive.'
		),
	path: z
		.string()
		.max(4096)
		.default('')
		.describe(
			"A folder to drill into: a path from an earlier answer's folders. Leave out for the drive's top."
		),
	folders: z
		.int()
		.min(1)
		.max(STORAGE_TOOL_LIMITS.maxFolders)
		.default(STORAGE_TOOL_LIMITS.defaultFolders)
		.describe('How many sub-folders to list, biggest first.'),
	folderOffset: z
		.int()
		.min(0)
		.max(1_000_000)
		.default(0)
		.describe('Skip this many sub-folders: the nextFolderOffset of an earlier answer.'),
	largestFiles: z
		.int()
		.min(0)
		.max(STORAGE_TOOL_LIMITS.maxLargestFiles)
		.default(STORAGE_TOOL_LIMITS.defaultLargestFiles)
		.describe('How many of the largest files under the folder to list (0 to 100).'),
	cleanUp: z
		.boolean()
		.default(true)
		.describe("Whether to measure BMuster's safe clean-up items (takes a few seconds).")
});

const drive = z.object({
	mount: z.string(),
	sizeBytes: z.number(),
	usedBytes: z.number(),
	freeBytes: z.number(),
	usedPercent: z.number(),
	lastScanFinishedAt: z.string().nullable().describe('When the last complete scan finished.'),
	lastScanAgeMinutes: z.number().nullable(),
	scanningPercent: z
		.number()
		.nullable()
		.describe('How far a scan running now has got; null when none runs.')
});

const cleanUpItem = z.object({
	id: z.enum(CLEANUP_ITEM_IDS),
	label: z.string(),
	explanation: z.string(),
	sizeBytes: z.number().nullable().describe('Null when the size cannot be known before cleaning.'),
	files: z.number().nullable()
});

export const getStorageOutput = z.object({
	machine: z.object({ id: z.string(), name: z.string() }),
	drives: z.array(drive),
	scanRunning: z.boolean(),
	problem: z.string().nullable().describe("The scanner's last problem, if any."),
	drive: z.string().nullable().describe('The drive the folder and files below are on.'),
	folder: z
		.object({
			path: z.string(),
			scanFinishedAt: z.string(),
			bytes: z.number(),
			files: z.number(),
			ownFilesBytes: z.number().describe("The folder's own files, outside its sub-folders."),
			smallFoldersBytes: z
				.number()
				.describe('Sub-folders too small to keep separately, counted here instead.'),
			notScannedBytes: z
				.number()
				.describe("At a drive's top: used space the scan could not see (system or no access)."),
			subfolders: z.array(
				z.object({
					name: z.string(),
					path: z.string(),
					bytes: z.number(),
					files: z.number(),
					percentOfFolder: z.number(),
					hasSubfolders: z.boolean()
				})
			),
			nextFolderOffset: z
				.int()
				.nullable()
				.describe('More sub-folders follow: call again with this folderOffset.')
		})
		.nullable()
		.describe('Null when the drive has not been scanned yet.'),
	largestFiles: z.array(
		z.object({ path: z.string(), bytes: z.number(), modifiedAt: z.string().nullable() })
	),
	cleanUp: z.object({
		measured: z.boolean(),
		why: z.string().nullable().describe('Why the items were not measured.'),
		items: z.array(cleanUpItem)
	}),
	message: z.string()
});

export type GetStorageOutput = z.infer<typeof getStorageOutput>;

export const rescanStorageInput = z.object({ machine: machineName });

export const rescanStorageOutput = z.object({
	machine: z.object({ id: z.string(), name: z.string() }),
	status: z.enum(['scan-started', 'already-scanning']),
	message: z.string()
});

export type RescanStorageOutput = z.infer<typeof rescanStorageOutput>;

export const cleanUpStorageInput = z.object({
	machine: machineName,
	items: z
		.array(cleanupItemIdSchema)
		.min(1)
		.max(CLEANUP_ITEM_IDS.length)
		.refine((ids) => new Set(ids).size === ids.length, 'An item is listed twice.')
		.describe("Ids of BMuster's safe clean-up items, from get_storage's cleanUp.items."),
	reason: z
		.string()
		.min(1)
		.max(ASSISTANT_RUN_LIMITS.maxReasonChars)
		.describe('Why, in a sentence. The person approving reads this.')
});

export const getCleanupResultInput = z.object({
	requestId: z.uuid().describe('The requestId clean_up_storage returned.'),
	waitSeconds: z
		.int()
		.min(0)
		.max(ASSISTANT_RUN_LIMITS.maxWaitSeconds)
		.default(ASSISTANT_RUN_LIMITS.maxWaitSeconds)
		.describe('How long to wait for the clean-up to end before answering with where it is up to.')
});

const CLEANUP_RESULT_STATUSES = [
	'pending-approval',
	'running',
	'finished',
	'interrupted',
	'denied',
	'expired',
	'cancelled'
] as const;

export const cleanupResultOutput = z.object({
	requestId: z.string(),
	status: z.enum(CLEANUP_RESULT_STATUSES),
	message: z.string(),
	approvalUrl: z.string(),
	expiresAt: z.string().nullable(),
	decidedBy: z.string().nullable(),
	denyNote: z.string().nullable(),
	machine: z.object({ id: z.string(), name: z.string() }),
	items: z.array(
		z.object({
			id: z.enum(CLEANUP_ITEM_IDS),
			label: z.string(),
			sizeWhenAskedBytes: z.number().nullable(),
			state: z.enum(['waiting', 'running', 'done']),
			freedBytes: z.number().nullable(),
			filesRemoved: z.number().nullable(),
			filesSkipped: z.number().nullable(),
			errors: z.number().nullable(),
			errorMessages: z.array(z.string())
		})
	),
	totals: z
		.object({
			freedBytes: z.number(),
			filesRemoved: z.number(),
			filesSkipped: z.number(),
			errors: z.number()
		})
		.nullable()
		.describe('Over the items done so far; null before the clean-up starts.')
});

export type CleanupResultOutput = z.infer<typeof cleanupResultOutput>;
