/**
 * File requests and replies (SPEC-FILES): the console's API, and the agent's
 * replies on a files session socket. The agent's side is
 * agent/crates/protocol/src/files.rs; both must change together.
 */
import { z } from 'zod';
import {
	ENTRY_KINDS,
	FILE_ERROR_CODES,
	type FileEntry,
	type FileRoot,
	type FolderListing
} from '#lib/domain/files/files.ts';

/** An absolute path; the agent checks its rules (absolute, no `..`, no device paths). */
export const filePathSchema = z
	.string()
	.min(1, 'Choose a folder.')
	.max(4096, 'That path is too long.')
	.refine((path) => !path.includes('\0'), 'That is not a path.');

/** One part of a path. The agent applies the full rules for its platform. */
export const fileNameSchema = z
	.string()
	.min(1, 'Type a name.')
	.max(255, 'That name is too long.')
	.refine(
		(name) => name !== '.' && name !== '..' && !/[/\0]/.test(name),
		'A name must be one name, not a path.'
	);

const bytes = z.int().min(0).max(Number.MAX_SAFE_INTEGER);

const fileEntrySchema: z.ZodType<FileEntry> = z.object({
	name: z.string(),
	kind: z.enum(ENTRY_KINDS),
	size: bytes,
	modifiedMs: z.int().nullable(),
	hidden: z.boolean(),
	linkTarget: z.string().nullable()
});

const fileRootSchema: z.ZodType<FileRoot> = z.object({
	path: z.string(),
	label: z.string(),
	kind: z.enum(['drive', 'mount']),
	totalBytes: bytes.nullable(),
	freeBytes: bytes.nullable()
});

/** `GET /api/machines/[id]/files/roots` */
export const rootsReplySchema = z.object({ roots: z.array(fileRootSchema) });

/** `GET /api/machines/[id]/files/list?path=` */
export const listingReplySchema: z.ZodType<FolderListing> = z.object({
	path: z.string(),
	entries: z.array(fileEntrySchema),
	more: z.boolean()
});

/** `POST …/files/folder` */
export const newFolderRequestSchema = z.object({ dir: filePathSchema, name: fileNameSchema });

/** `POST …/files/rename` */
export const renameRequestSchema = z.object({
	dir: filePathSchema,
	from: fileNameSchema,
	to: fileNameSchema
});

/** `POST …/files/delete`: folders with something in them need `recursive`. */
export const deleteRequestSchema = z.object({
	dir: filePathSchema,
	names: z.array(fileNameSchema).min(1, 'Choose something to delete.').max(1000),
	recursive: z.boolean()
});

/** A new path (folder, rename). */
export const pathReplySchema = z.object({ path: z.string() });

export const deleteReplySchema = z.object({
	removed: z.array(z.string()),
	items: bytes,
	failed: z.array(z.object({ name: z.string(), message: z.string() }))
});

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'Not a SHA-256 in hex.');

/** `POST …/files/upload/begin` */
export const uploadBeginRequestSchema = z.object({
	dir: filePathSchema,
	name: fileNameSchema,
	size: bytes,
	replace: z.boolean()
});

/** `PUT …/files/upload?dir=&name=&offset=`: the query, checked like a body. */
export const uploadChunkQuerySchema = z.object({
	dir: filePathSchema,
	name: fileNameSchema,
	offset: z.coerce.number().pipe(bytes)
});

/** How much of an upload the machine holds. */
export const partReplySchema = z.object({ partSize: bytes });

/** `POST …/files/upload/end` */
export const uploadEndRequestSchema = z.object({
	dir: filePathSchema,
	name: fileNameSchema,
	size: bytes,
	sha256: sha256Schema
});

export const uploadEndReplySchema = z.object({
	path: z.string(),
	size: bytes,
	sha256: sha256Schema
});

/** `POST …/files/upload/cancel` */
export const uploadCancelRequestSchema = z.object({ dir: filePathSchema, name: fileNameSchema });

export const emptyReplySchema = z.object({});

/** The agent's answer to one request, before its result is read for the op. */
export const agentFilesReplySchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('done'), id: z.int().min(0), result: z.unknown() }),
	z.object({
		type: z.literal('error'),
		id: z.int().min(0),
		code: z.enum(FILE_ERROR_CODES),
		message: z.string().max(4000)
	})
]);

export const agentStatSchema = z.object({
	kind: z.enum(ENTRY_KINDS),
	size: bytes,
	modifiedMs: z.int().nullable()
});

export const agentReadDoneSchema = z.object({ bytes });
