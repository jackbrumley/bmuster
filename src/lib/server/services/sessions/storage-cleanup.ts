import type { CleanupItemId, CleanupRun } from '#lib/domain/storage/cleanup.ts';
import { emptyReplySchema } from '#lib/schemas/files/files.ts';
import { cleanupSizesReplySchema, cleanupStatusReplySchema } from '#lib/schemas/storage/cleanup.ts';
import { recordCleanupResult, recordCleanupStart } from '../machines/storage-cleanups.ts';
import {
	ANSWER_MS,
	outcomeOf,
	withChannel,
	type FilesContext,
	type FilesOutcome
} from './files.ts';

/**
 * Storage clean-up (SPEC-STORAGE 11): **security work**, it deletes files on the machine. Every
 * request runs on the person's files session, so the server checks `view` and `files` through the
 * access service each time and the agent runs it only on a `files` ticket. Only item ids are
 * sent; the agent decides every folder and command from them. The start and the result are
 * audited.
 */

/** What each item offered on the machine would free. Read only; it may walk a few folders. */
export function cleanupSizes(context: FilesContext) {
	return withChannel(context, async (channel) =>
		outcomeOf(
			await channel.ask({ op: 'storage-cleanup-sizes' }, ANSWER_MS.slow),
			cleanupSizesReplySchema
		)
	);
}

/** How long an AI assistant waits for the sizes before it is told to ask again (SPEC-MCP M50). */
const ASSISTANT_SIZING_MS = 20_000;

/**
 * The sizes for an AI assistant's tool call, which must answer within its 45 s: a refusal after
 * 20 s rather than the Storage tab's long wait. The machine finishes measuring regardless.
 */
export function cleanupSizesSoon(context: FilesContext) {
	return new Promise<Awaited<ReturnType<typeof cleanupSizes>>>((resolve) => {
		const timer = setTimeout(() => {
			resolve({
				kind: 'refused',
				status: 504,
				message: 'The machine took too long to measure the clean-up items. Ask again in a minute.'
			});
		}, ASSISTANT_SIZING_MS);
		void cleanupSizes(context).then((sizes) => {
			clearTimeout(timer);
			resolve(sizes);
		});
	});
}

/**
 * Starts a clean-up of `items` (already checked as ids); recorded and audited once accepted.
 * `asked` names who asked for it when a person approved an AI assistant's request; else `{}`.
 */
export function startCleanup(
	context: FilesContext,
	items: CleanupItemId[],
	asked: Record<string, string>
): Promise<FilesOutcome<{ runId: string }>> {
	return withChannel(context, async (channel, machine) => {
		const runId = crypto.randomUUID();
		const started = outcomeOf(
			await channel.ask({ op: 'storage-cleanup-start', runId, items }, ANSWER_MS.quick),
			emptyReplySchema
		);
		if (started.kind === 'refused') {
			return started;
		}
		context.database.transaction((transaction) => {
			recordCleanupStart(
				transaction,
				{ runId, machineId: machine.id, userId: context.user.id, items, asked },
				Date.now()
			);
		});
		return { kind: 'ok', value: { runId } };
	});
}

/** The machine's last clean-up; a result seen for the first time is recorded and audited. */
export function cleanupStatus(context: FilesContext): Promise<FilesOutcome<{ run: CleanupRun }>> {
	return withChannel(context, async (channel, machine) => {
		const status = outcomeOf(
			await channel.ask({ op: 'storage-cleanup-status' }, ANSWER_MS.quick),
			cleanupStatusReplySchema
		);
		if (status.kind === 'ok') {
			context.database.transaction((transaction) => {
				recordCleanupResult(transaction, machine.id, status.value.run, Date.now());
			});
		}
		return status;
	});
}
