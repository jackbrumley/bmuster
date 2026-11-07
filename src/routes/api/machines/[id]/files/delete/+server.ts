import { route } from '#lib/server/guards/route.ts';
import { deleteEntries } from '#lib/server/services/sessions/files.ts';
import { deleteRequestSchema } from '#lib/schemas/files/files.ts';
import { invalidRequest, readJson } from '../../../../replies.server.ts';
import { filesContext, filesReply } from '../files.server.ts';
import type { RequestHandler } from './$types';

/**
 * POST /api/machines/<id>/files/delete: deletes names in one folder
 * (SPEC-FILES F7), audited. Links go as links; full folders need `recursive`.
 */
export const POST: RequestHandler = route.user(async (event, { user }) => {
	const parsed = deleteRequestSchema.safeParse(await readJson(event.request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	const { dir, names, recursive } = parsed.data;
	return filesReply(await deleteEntries(filesContext(event, user), dir, names, recursive));
});
