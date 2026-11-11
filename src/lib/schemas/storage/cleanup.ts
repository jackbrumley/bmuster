/**
 * Storage clean-up contracts (SPEC-STORAGE 11): the agent's answers on a files session, the
 * console's API and the check-in's last run. The agent's side is
 * agent/crates/protocol/src/cleanup.rs; both must change together.
 */
import { z } from 'zod';
import {
	CLEANUP_ITEM_IDS,
	type CleanupItemProgress,
	type CleanupItemSize,
	type CleanupRun
} from '#lib/domain/storage/cleanup.ts';

const count = z.int().min(0).max(Number.MAX_SAFE_INTEGER);
const ms = z.int();

const cleanupItemIdSchema = z.enum(CLEANUP_ITEM_IDS);

const itemSizeSchema: z.ZodType<CleanupItemSize> = z.object({
	id: cleanupItemIdSchema,
	size: z.discriminatedUnion('kind', [
		z.object({ kind: z.literal('bytes'), bytes: count, files: count }),
		z.object({ kind: z.literal('unknown') })
	])
});

/** `GET /api/machines/[id]/storage/cleanup/items` */
export const cleanupSizesReplySchema = z.object({
	items: z.array(itemSizeSchema).max(CLEANUP_ITEM_IDS.length)
});

const itemProgressSchema: z.ZodType<CleanupItemProgress> = z.object({
	id: cleanupItemIdSchema,
	state: z.discriminatedUnion('kind', [
		z.object({ kind: z.literal('waiting') }),
		z.object({ kind: z.literal('running'), freedBytes: count, filesRemoved: count }),
		z.object({
			kind: z.literal('done'),
			result: z.object({
				freedBytes: count,
				measured: z.enum(['counted', 'free-space']),
				filesRemoved: count,
				filesSkipped: count,
				errors: count,
				messages: z.array(z.string().max(4096)).max(5)
			})
		})
	])
});

const items = z.array(itemProgressSchema).max(CLEANUP_ITEM_IDS.length);
const runId = z.uuid();

export const cleanupRunSchema: z.ZodType<CleanupRun> = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('none') }),
	z.object({ kind: z.literal('running'), runId, startedAtMs: ms, items }),
	z.object({
		kind: z.literal('finished'),
		runId,
		startedAtMs: ms,
		finishedAtMs: ms,
		items
	}),
	z.object({ kind: z.literal('interrupted'), runId, startedAtMs: ms, items })
]);

/** `GET /api/machines/[id]/storage/cleanup` (the agent's `storage-cleanup-status`). */
export const cleanupStatusReplySchema = z.object({ run: cleanupRunSchema });

/** `POST /api/machines/[id]/storage/cleanup`: ids only, each once, nothing else. */
export const cleanupStartRequestSchema = z.strictObject({
	items: z
		.array(cleanupItemIdSchema)
		.min(1)
		.max(CLEANUP_ITEM_IDS.length)
		.refine((ids) => new Set(ids).size === ids.length, 'An item is listed twice.')
});

/** The start's reply: the new run's id. */
export const cleanupStartReplySchema = z.object({ runId });
