import { route } from '#lib/server/guards/route.ts';
import { storageLargest } from '#lib/server/services/sessions/storage.ts';
import { largestQuerySchema } from '#lib/schemas/storage/storage.ts';
import { invalidRequest } from '../../../../replies.server.ts';
import { filesContext, filesReply, queryValue } from '../../files/files.server.ts';
import type { RequestHandler } from './$types';

/** GET /api/machines/<id>/storage/largest?mount=&path=: the largest files under a folder (SPEC-STORAGE 5). */
export const GET: RequestHandler = route.user(async (event, { user }) => {
	const query = largestQuerySchema.safeParse({
		mount: queryValue(event, 'mount'),
		path: queryValue(event, 'path')
	});
	if (!query.success) {
		return invalidRequest(query.error);
	}
	return filesReply(
		await storageLargest(filesContext(event, user), query.data.mount, query.data.path)
	);
});
