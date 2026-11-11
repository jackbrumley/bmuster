import {
	folderViewReplySchema,
	largestReplySchema,
	rescanReplySchema,
	storageSummaryReplySchema
} from '#lib/schemas/storage/storage.ts';
import { ANSWER_MS, auditFiles, outcomeOf, withChannel, type FilesContext } from './files.ts';

/**
 * Storage (SPEC-STORAGE 5): the agent's last scans, read live on the person's files session. The
 * same checks as Files run on every request (`view` and `files` through the access service, a
 * signed `files` ticket for the agent), so whoever may not see the folders may not see their
 * names either. Reading is not audited, as Files listing is not; Rescan now is.
 */

export function storageSummary(context: FilesContext) {
	return withChannel(context, async (channel) =>
		outcomeOf(
			await channel.ask({ op: 'storage-summary' }, ANSWER_MS.quick),
			storageSummaryReplySchema
		)
	);
}

export function storageFolder(context: FilesContext, mount: string, path: string, offset: number) {
	return withChannel(context, async (channel) =>
		outcomeOf(
			await channel.ask({ op: 'storage-folder', mount, path, offset }, ANSWER_MS.quick),
			folderViewReplySchema
		)
	);
}

export function storageLargest(context: FilesContext, mount: string, path: string) {
	return withChannel(context, async (channel) =>
		outcomeOf(
			await channel.ask({ op: 'storage-largest', mount, path }, ANSWER_MS.quick),
			largestReplySchema
		)
	);
}

/**
 * Rescan now: the agent starts a pass within a second, or says one is already running (S25,
 * S26). Audited when a pass was asked for.
 */
export function requestRescan(context: FilesContext) {
	return withChannel(context, async (channel, machine) => {
		const asked = outcomeOf(
			await channel.ask({ op: 'storage-rescan' }, ANSWER_MS.quick),
			rescanReplySchema
		);
		if (asked.kind === 'ok' && !asked.value.alreadyScanning) {
			auditFiles(context, machine, 'storage-rescan-requested', {});
		}
		return asked;
	});
}
