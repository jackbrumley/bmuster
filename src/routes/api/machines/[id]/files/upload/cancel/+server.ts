import { route } from '#lib/server/guards/route.ts';
import { cancelUpload } from '#lib/server/services/sessions/files.ts';
import { uploadCancelRequestSchema } from '#lib/schemas/files/files.ts';
import { invalidRequest, readJson } from '../../../../../replies.server.ts';
import { filesContext, filesReply } from '../../files.server.ts';
import type { RequestHandler } from './$types';

/** POST /api/machines/<id>/files/upload/cancel: gives an upload up and removes its part file (SPEC-FILES F6). */
export const POST: RequestHandler = route.user(async (event, { user }) => {
	const parsed = uploadCancelRequestSchema.safeParse(await readJson(event.request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	return filesReply(await cancelUpload(filesContext(event, user), parsed.data));
});
