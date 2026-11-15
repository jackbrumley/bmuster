import { route } from '#lib/server/guards/route.ts';
import { sendChunk } from '#lib/server/services/sessions/session-files.ts';
import { sendChunkQuerySchema } from '#lib/schemas/session-files/session-files.ts';
import { invalidRequest } from '../../../../replies.server.ts';
import { sessionFilesContext, sessionFilesReply } from '../session-files.server.ts';
import type { RequestHandler } from './$types';

/** PUT /api/machines/<id>/session-files/send?transferId=&offset=: one piece, at most 8 MB. */
export const PUT: RequestHandler = route.user(async (event, { user }) => {
	const query = sendChunkQuerySchema.safeParse({
		transferId: event.url.searchParams.get('transferId') ?? '',
		offset: event.url.searchParams.get('offset') ?? ''
	});
	if (!query.success) {
		return invalidRequest(query.error);
	}
	const data = new Uint8Array(await event.request.arrayBuffer());
	return sessionFilesReply(await sendChunk(sessionFilesContext(event, user), query.data, data));
});
