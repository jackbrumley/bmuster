import { route } from '#lib/server/guards/route.ts';
import { cleanupSizes } from '#lib/server/services/sessions/storage-cleanup.ts';
import { filesContext, filesReply } from '../../../files/files.server.ts';
import type { RequestHandler } from './$types';

/** GET /api/machines/<id>/storage/cleanup/items: each offered clean-up item and its size (SPEC-STORAGE 11.5). */
export const GET: RequestHandler = route.user(async (event, { user }) =>
	filesReply(await cleanupSizes(filesContext(event, user)))
);
