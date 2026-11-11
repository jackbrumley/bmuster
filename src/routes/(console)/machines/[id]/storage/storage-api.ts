import { resolve } from '$app/paths';
import { emptyReplySchema } from '#lib/schemas/files/files.ts';
import {
	folderViewReplySchema,
	largestReplySchema,
	storageSummaryReplySchema
} from '#lib/schemas/storage/storage.ts';
import { apiRequest } from '#lib/utils/api-client.ts';

/** The Storage tab's calls to the server (SPEC-STORAGE 5). */
export function storageApi(machineId: string) {
	const params = { id: machineId };
	const query = (values: Record<string, string>): string => new URLSearchParams(values).toString();

	return {
		summary: () =>
			apiRequest({
				method: 'GET',
				url: resolve('/api/machines/[id]/storage/summary', params),
				body: undefined,
				reply: storageSummaryReplySchema
			}),
		folder: (mount: string, path: string, offset: number) =>
			apiRequest({
				method: 'GET',
				url: `${resolve('/api/machines/[id]/storage/folder', params)}?${query({ mount, path, offset: String(offset) })}`,
				body: undefined,
				reply: folderViewReplySchema
			}),
		largest: (mount: string, path: string) =>
			apiRequest({
				method: 'GET',
				url: `${resolve('/api/machines/[id]/storage/largest', params)}?${query({ mount, path })}`,
				body: undefined,
				reply: largestReplySchema
			}),
		rescan: () =>
			apiRequest({
				method: 'POST',
				url: resolve('/api/machines/[id]/storage/rescan', params),
				body: {},
				reply: emptyReplySchema
			})
	};
}
