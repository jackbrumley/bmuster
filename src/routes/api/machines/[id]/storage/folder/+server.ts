import { route } from '#lib/server/guards/route.ts';
import { storageFolder } from '#lib/server/services/sessions/storage.ts';
import { folderQuerySchema } from '#lib/schemas/storage/storage.ts';
import { invalidRequest } from '../../../../replies.server.ts';
import { filesContext, filesReply, queryValue } from '../../files/files.server.ts';
import type { RequestHandler } from './$types';

/**
 * GET /api/machines/<id>/storage/folder?mount=&path=&offset=: one scanned folder, its
 * sub-folders biggest first (SPEC-STORAGE 5). Not audited, as Files listing is not.
 */
export const GET: RequestHandler = route.user(async (event, { user }) => {
	const query = folderQuerySchema.safeParse({
		mount: queryValue(event, 'mount'),
		path: queryValue(event, 'path'),
		offset: event.url.searchParams.get('offset') ?? '0'
	});
	if (!query.success) {
		return invalidRequest(query.error);
	}
	const { mount, path, offset } = query.data;
	return filesReply(await storageFolder(filesContext(event, user), mount, path, offset));
});
