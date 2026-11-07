import { route } from '#lib/server/guards/route.ts';
import { renameEntry } from '#lib/server/services/sessions/files.ts';
import { renameRequestSchema } from '#lib/schemas/files/files.ts';
import { invalidRequest, readJson } from '../../../../replies.server.ts';
import { filesContext, filesReply } from '../files.server.ts';
import type { RequestHandler } from './$types';

/** POST /api/machines/<id>/files/rename: renames within one folder (SPEC-FILES F7), audited. */
export const POST: RequestHandler = route.user(async (event, { user }) => {
	const parsed = renameRequestSchema.safeParse(await readJson(event.request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	const { dir, from, to } = parsed.data;
	return filesReply(await renameEntry(filesContext(event, user), dir, from, to));
});
