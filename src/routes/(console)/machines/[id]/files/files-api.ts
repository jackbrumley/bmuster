import { resolve } from '$app/paths';
import {
	deleteReplySchema,
	emptyReplySchema,
	listingReplySchema,
	partReplySchema,
	pathReplySchema,
	rootsReplySchema,
	uploadEndReplySchema
} from '#lib/schemas/files/files.ts';
import { apiRequest, apiUpload } from '#lib/utils/api-client.ts';

/**
 * The Files tab's calls to the server (SPEC-FILES). Every one goes through
 * the API client; downloads are plain links so the browser's own download
 * manager shows progress and resumes them.
 */

export function filesApi(machineId: string) {
	const params = { id: machineId };
	const urls = {
		roots: resolve('/api/machines/[id]/files/roots', params),
		list: resolve('/api/machines/[id]/files/list', params),
		folder: resolve('/api/machines/[id]/files/folder', params),
		rename: resolve('/api/machines/[id]/files/rename', params),
		delete: resolve('/api/machines/[id]/files/delete', params),
		download: resolve('/api/machines/[id]/files/download', params),
		upload: resolve('/api/machines/[id]/files/upload', params),
		'upload/begin': resolve('/api/machines/[id]/files/upload/begin', params),
		'upload/end': resolve('/api/machines/[id]/files/upload/end', params),
		'upload/cancel': resolve('/api/machines/[id]/files/upload/cancel', params)
	};
	const base = (path: keyof typeof urls): string => urls[path];
	const query = (values: Record<string, string>): string => new URLSearchParams(values).toString();

	return {
		roots: () =>
			apiRequest({ method: 'GET', url: base('roots'), body: undefined, reply: rootsReplySchema }),
		list: (path: string) =>
			apiRequest({
				method: 'GET',
				url: `${base('list')}?${query({ path })}`,
				body: undefined,
				reply: listingReplySchema
			}),
		newFolder: (dir: string, name: string) =>
			apiRequest({
				method: 'POST',
				url: base('folder'),
				body: { dir, name },
				reply: pathReplySchema
			}),
		rename: (dir: string, from: string, to: string) =>
			apiRequest({
				method: 'POST',
				url: base('rename'),
				body: { dir, from, to },
				reply: pathReplySchema
			}),
		/** Callers confirm first (the tab asks with confirmAction or confirmByTyping). */
		remove: (dir: string, names: string[], recursive: boolean) =>
			apiRequest({
				method: 'POST',
				url: base('delete'),
				body: { dir, names, recursive },
				reply: deleteReplySchema
			}),
		downloadUrl: (path: string) => `${base('download')}?${query({ path })}`,
		beginUpload: (dir: string, name: string, size: number, replace: boolean) =>
			apiRequest({
				method: 'POST',
				url: base('upload/begin'),
				body: { dir, name, size, replace },
				reply: partReplySchema
			}),
		uploadChunk: (
			target: { dir: string; name: string; offset: number },
			body: Blob,
			onProgress: (sentBytes: number) => void,
			signal: AbortSignal
		) =>
			apiUpload({
				url: `${base('upload')}?${query({ dir: target.dir, name: target.name, offset: String(target.offset) })}`,
				body,
				reply: partReplySchema,
				onProgress,
				signal
			}),
		endUpload: (dir: string, name: string, size: number, sha256: string) =>
			apiRequest({
				method: 'POST',
				url: base('upload/end'),
				body: { dir, name, size, sha256 },
				reply: uploadEndReplySchema
			}),
		cancelUpload: (dir: string, name: string) =>
			apiRequest({
				method: 'POST',
				url: base('upload/cancel'),
				body: { dir, name },
				reply: emptyReplySchema
			})
	};
}
