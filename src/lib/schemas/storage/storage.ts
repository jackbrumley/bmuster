/**
 * Storage replies (SPEC-STORAGE): the agent's answers on a files session,
 * the console's API, and the check-in's per-drive summary. The agent's side
 * is agent/crates/protocol/src/storage.rs; both must change together.
 */
import { z } from 'zod';
import type {
	DriveSummary,
	FolderView,
	LargeFile,
	StorageSummary
} from '#lib/domain/storage/storage.ts';
import { filePathSchema } from '../files/files.ts';
import { cleanupRunSchema } from './cleanup.ts';

const bytes = z.int().min(0).max(Number.MAX_SAFE_INTEGER);
const ms = z.int();

const driveSummarySchema: z.ZodType<DriveSummary> = z.object({
	mount: z.string().max(4096),
	sizeBytes: bytes,
	freeBytes: bytes,
	lastScan: z.discriminatedUnion('kind', [
		z.object({ kind: z.literal('none') }),
		z.object({
			kind: z.literal('complete'),
			startedAtMs: ms,
			finishedAtMs: ms,
			scannedBytes: bytes,
			usedBytes: bytes,
			files: bytes,
			folders: bytes,
			denied: bytes
		})
	]),
	scanning: z.discriminatedUnion('kind', [
		z.object({ kind: z.literal('idle') }),
		z.object({ kind: z.literal('running'), startedAtMs: ms, percent: z.int().min(0).max(100) })
	])
});

/** `GET /api/machines/[id]/storage/summary` */
export const storageSummaryReplySchema: z.ZodType<StorageSummary> = z.object({
	drives: z.array(driveSummarySchema).max(64),
	problem: z.discriminatedUnion('kind', [
		z.object({ kind: z.literal('none') }),
		z.object({ kind: z.literal('failed'), message: z.string(), atMs: ms })
	])
});

/** `GET /api/machines/[id]/storage/folder` */
export const folderViewReplySchema: z.ZodType<FolderView> = z.object({
	mount: z.string(),
	path: z.string(),
	finishedAtMs: ms,
	bytes,
	files: bytes,
	ownBytes: bytes,
	ownFiles: bytes,
	foldedFolders: bytes,
	foldedBytes: bytes,
	notScannedBytes: bytes,
	children: z
		.array(
			z.object({
				name: z.string(),
				path: z.string(),
				bytes,
				files: bytes,
				hasChildren: z.boolean()
			})
		)
		.max(200),
	offset: bytes,
	more: z.boolean()
});

const largeFileSchema: z.ZodType<LargeFile> = z.object({
	path: z.string(),
	bytes,
	modifiedMs: ms.nullable()
});

/** `GET /api/machines/[id]/storage/largest` */
export const largestReplySchema = z.object({ files: z.array(largeFileSchema).max(100) });

/** The check-in's `storage`; older agents send none. */
export const storageReportSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('unreported') }),
	z.object({
		kind: z.literal('reported'),
		drives: z.array(driveSummarySchema).max(64),
		// The last clean-up (SPEC-STORAGE 11.4); agents before it send none.
		cleanup: cleanupRunSchema.default({ kind: 'none' })
	})
]);

/**
 * `POST /api/machines/[id]/storage/rescan`: whether a pass was already running (S26). An agent
 * before 0.4.18 answers `{}`, which means it was asked.
 */
export const rescanReplySchema = z.object({ alreadyScanning: z.boolean().default(false) });

export type StorageReport = z.infer<typeof storageReportSchema>;

/** `?mount=&path=&offset=` of the folder route. */
export const folderQuerySchema = z.object({
	mount: filePathSchema,
	path: filePathSchema,
	offset: z.coerce.number().int().min(0).max(1_000_000)
});

/** `?mount=&path=` of the largest files route. */
export const largestQuerySchema = z.object({ mount: filePathSchema, path: filePathSchema });

/** What the server keeps per machine (`machine_storage.drives`). */
export const storedDrivesSchema = z.array(driveSummarySchema);
