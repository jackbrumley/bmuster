import { route } from '#lib/server/guards/route.ts';
import { cleanupStatus, startCleanup } from '#lib/server/services/sessions/storage-cleanup.ts';
import { cleanupStartRequestSchema } from '#lib/schemas/storage/cleanup.ts';
import { invalidRequest, readJson } from '../../../../replies.server.ts';
import { filesContext, filesReply } from '../../files/files.server.ts';
import type { RequestHandler } from './$types';

/** GET /api/machines/<id>/storage/cleanup: the last clean-up's progress or results (SPEC-STORAGE 11.5). */
export const GET: RequestHandler = route.user(async (event, { user }) =>
	filesReply(await cleanupStatus(filesContext(event, user)))
);

/**
 * POST /api/machines/<id>/storage/cleanup `{ items }`: starts a clean-up of these item ids
 * (SPEC-STORAGE 11.5). Ids only, each once; audited.
 */
export const POST: RequestHandler = route.user(async (event, { user }) => {
	const parsed = cleanupStartRequestSchema.safeParse(await readJson(event.request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	return filesReply(await startCleanup(filesContext(event, user), parsed.data.items));
});
