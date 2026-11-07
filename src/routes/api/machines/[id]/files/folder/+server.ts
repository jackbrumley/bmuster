import { route } from '#lib/server/guards/route.ts';
import { newFolder } from '#lib/server/services/sessions/files.ts';
import { newFolderRequestSchema } from '#lib/schemas/files/files.ts';
import { invalidRequest, readJson } from '../../../../replies.server.ts';
import { filesContext, filesReply } from '../files.server.ts';
import type { RequestHandler } from './$types';

/** POST /api/machines/<id>/files/folder: a new folder (SPEC-FILES F7), audited. */
export const POST: RequestHandler = route.user(async (event, { user }) => {
	const parsed = newFolderRequestSchema.safeParse(await readJson(event.request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	return filesReply(await newFolder(filesContext(event, user), parsed.data.dir, parsed.data.name));
});
