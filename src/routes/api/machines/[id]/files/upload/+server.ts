import { route } from '#lib/server/guards/route.ts';
import { uploadChunk } from '#lib/server/services/sessions/files.ts';
import { uploadChunkQuerySchema } from '#lib/schemas/files/files.ts';
import { invalidRequest } from '../../../../replies.server.ts';
import { filesContext, filesReply, queryValue } from '../files.server.ts';
import type { RequestHandler } from './$types';

/**
 * PUT /api/machines/<id>/files/upload?dir=&name=&offset=: one piece of an
 * upload, at most 8 MB, written where the part file ends (SPEC-FILES F6).
 */
export const PUT: RequestHandler = route.user(async (event, { user }) => {
	const query = uploadChunkQuerySchema.safeParse({
		dir: queryValue(event, 'dir'),
		name: queryValue(event, 'name'),
		offset: queryValue(event, 'offset')
	});
	if (!query.success) {
		return invalidRequest(query.error);
	}
	const data = new Uint8Array(await event.request.arrayBuffer());
	return filesReply(await uploadChunk(filesContext(event, user), query.data, data));
});
