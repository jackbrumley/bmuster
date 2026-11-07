import { route } from '#lib/server/guards/route.ts';
import { endUpload } from '#lib/server/services/sessions/files.ts';
import { uploadEndRequestSchema } from '#lib/schemas/files/files.ts';
import { invalidRequest, readJson } from '../../../../../replies.server.ts';
import { filesContext, filesReply } from '../../files.server.ts';
import type { RequestHandler } from './$types';

/** POST /api/machines/<id>/files/upload/end: checks the size and SHA-256 and puts the file in place, audited (SPEC-FILES F6). */
export const POST: RequestHandler = route.user(async (event, { user }) => {
	const parsed = uploadEndRequestSchema.safeParse(await readJson(event.request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	return filesReply(await endUpload(filesContext(event, user), parsed.data));
});
