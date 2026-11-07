import { route } from '#lib/server/guards/route.ts';
import { beginUpload } from '#lib/server/services/sessions/files.ts';
import { uploadBeginRequestSchema } from '#lib/schemas/files/files.ts';
import { invalidRequest, readJson } from '../../../../../replies.server.ts';
import { filesContext, filesReply } from '../../files.server.ts';
import type { RequestHandler } from './$types';

/** POST /api/machines/<id>/files/upload/begin: starts or resumes an upload: how much the machine already holds (SPEC-FILES F6). */
export const POST: RequestHandler = route.user(async (event, { user }) => {
	const parsed = uploadBeginRequestSchema.safeParse(await readJson(event.request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	return filesReply(await beginUpload(filesContext(event, user), parsed.data));
});
