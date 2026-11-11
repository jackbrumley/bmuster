import { route } from '#lib/server/guards/route.ts';
import { storageSummary } from '#lib/server/services/sessions/storage.ts';
import { filesContext, filesReply } from '../../files/files.server.ts';
import type { RequestHandler } from './$types';

/** GET /api/machines/<id>/storage/summary: each scanned drive and its scan state (SPEC-STORAGE 5). */
export const GET: RequestHandler = route.user(async (event, { user }) =>
	filesReply(await storageSummary(filesContext(event, user)))
);
