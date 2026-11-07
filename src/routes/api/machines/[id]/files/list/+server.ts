import { route } from '#lib/server/guards/route.ts';
import { listFolder } from '#lib/server/services/sessions/files.ts';
import { filePathSchema } from '#lib/schemas/files/files.ts';
import { invalidRequest } from '../../../../replies.server.ts';
import { filesContext, filesReply, queryValue } from '../files.server.ts';
import type { RequestHandler } from './$types';

/** GET /api/machines/<id>/files/list?path=: one folder (SPEC-FILES F3). Not audited. */
export const GET: RequestHandler = route.user(async (event, { user }) => {
	const path = filePathSchema.safeParse(queryValue(event, 'path'));
	if (!path.success) {
		return invalidRequest(path.error);
	}
	return filesReply(await listFolder(filesContext(event, user), path.data));
});
