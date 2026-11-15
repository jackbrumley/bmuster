/**
 * Storage clean-up contracts (SPEC-STORAGE 11): the agent's answers on a files session, the
 * console's API and the check-in's last run. The agent's side is
 * agent/crates/protocol/src/cleanup.rs; both must change together.
 */
import { z } from 'zod';
import { recheckSchema } from '../auth/recheck.ts';
import {
	CLEANUP_ITEM_IDS,
	type CleanupItemProgress,
	type CleanupItemSize,
	type CleanupRun
} from '#lib/domain/storage/cleanup.ts';

const count = z.int().min(0).max(Number.MAX_SAFE_INTEGER);
const ms = z.int();

export const cleanupItemIdSchema = z.enum(CLEANUP_ITEM_IDS);

const itemSizeSchema: z.ZodType<CleanupItemSize> = z.object({
	id: cleanupItemIdSchema,
	size: z.discriminatedUnion('kind', [
		z.object({ kind: z.literal('bytes'), bytes: count, files: count }),
		z.object({ kind: z.literal('unknown') })
	])
});

/** Item sizes, as the machine measured them; kept with an assistant's request (SPEC-MCP M53). */
export const cleanupSizesSchema = z.array(itemSizeSchema).max(CLEANUP_ITEM_IDS.length);

/** Item ids, as stored with an assistant's request. */
export const cleanupItemIdsSchema = z.array(cleanupItemIdSchema).max(CLEANUP_ITEM_IDS.length);

/** `GET /api/machines/[id]/storage/cleanup/items` */
export const cleanupSizesReplySchema = z.object({ items: cleanupSizesSchema });

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

/** A recorded result (`storage_cleanups.outcome`). */
export const cleanupOutcomeSchema = z.object({
	kind: z.enum(['finished', 'interrupted']),
	items
});

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

/**
 * `POST /api/approvals/clean-ups/<id>/approve` (SPEC-MCP M54): the password or code when the
 * sign-in is not recent. The items cannot be changed.
 */
export const cleanupApproveRequestSchema = z.object({ recheck: recheckSchema });

/** The approve and deny replies. */
export const cleanupDecidedReplySchema = z.object({ requestId: runId });
