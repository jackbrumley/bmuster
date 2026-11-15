import { resolve } from '$app/paths';
import {
	clipboardOfferSchema,
	emptyReplySchema,
	partReplySchema,
	sendBeginReplySchema,
	sendEndReplySchema,
	sendFinishReplySchema,
	sendTargetSchema,
	transfersReplySchema
} from '#lib/schemas/session-files/session-files.ts';
import { apiRequest, apiUpload } from '#lib/utils/api-client.ts';
import type { SessionDestination, UploadApi } from '../files/upload-queue.svelte.ts';

/** The desktop's calls for files sent through the screen (SPEC-SESSION-FILES 4.8). */
export function sessionFilesApi(machineId: string) {
	const params = { id: machineId };
	const urls = {
		target: resolve('/api/machines/[id]/session-files/destination', params),
		send: resolve('/api/machines/[id]/session-files/send', params),
		begin: resolve('/api/machines/[id]/session-files/send/begin', params),
		end: resolve('/api/machines/[id]/session-files/send/end', params),
		cancel: resolve('/api/machines/[id]/session-files/send/cancel', params),
		finish: resolve('/api/machines/[id]/session-files/send/finish', params),
		transfers: resolve('/api/machines/[id]/session-files/transfers', params),
		offer: resolve('/api/machines/[id]/session-files/offer', params)
	};

	const uploads: UploadApi<SessionDestination> = {
		begin: async (upload) => {
			const begun = await apiRequest({
				method: 'POST',
				url: urls.begin,
				body: {
					desktopSessionId: upload.destination.desktopSessionId,
					batchId: upload.destination.batchId,
					transferId: upload.remoteId,
					name: upload.name,
					size: upload.size
				},
				reply: sendBeginReplySchema
			});
			if (!begun.ok) {
				return begun;
			}
			upload.remoteId = begun.data.transferId;
			return { ok: true, data: { partSize: begun.data.partSize } };
		},
		chunk: (upload, offset, body, onProgress, signal) =>
			apiUpload({
				url: `${urls.send}?${new URLSearchParams({ transferId: upload.remoteId ?? '', offset: String(offset) }).toString()}`,
				body,
				reply: partReplySchema,
				onProgress,
				signal
			}),
		end: (upload, sha256) =>
			apiRequest({
				method: 'POST',
				url: urls.end,
				body: { transferId: upload.remoteId, sha256 },
				reply: sendEndReplySchema
			}),
		cancel: (upload) =>
			upload.remoteId === null ? Promise.resolve() : cancelTransfer(upload.remoteId)
	};

	/** The caller confirms nothing: cancelling a running upload loses only its unfinished part. */
	function cancelTransfer(transferId: string) {
		return apiRequest({
			method: 'POST',
			url: urls.cancel,
			body: { transferId },
			reply: emptyReplySchema
		});
	}

	return {
		uploads,
		cancelTransfer,
		target: (desktopSessionId: string) =>
			apiRequest({
				method: 'GET',
				url: `${urls.target}?${new URLSearchParams({ desktopSessionId }).toString()}`,
				body: undefined,
				reply: sendTargetSchema
			}),
		finish: (batchId: string, shareClipboard: boolean) =>
			apiRequest({
				method: 'POST',
				url: urls.finish,
				body: { batchId, shareClipboard },
				reply: sendFinishReplySchema
			}),
		offer: (desktopSessionId: string) =>
			apiRequest({
				method: 'GET',
				url: `${urls.offer}?${new URLSearchParams({ desktopSessionId }).toString()}`,
				body: undefined,
				reply: clipboardOfferSchema
			}),
		transfers: () =>
			apiRequest({
				method: 'GET',
				url: urls.transfers,
				body: undefined,
				reply: transfersReplySchema
			})
	};
}

export type SessionFilesApi = ReturnType<typeof sessionFilesApi>;
