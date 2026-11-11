import { route } from '#lib/server/guards/route.ts';
import { requestRescan } from '#lib/server/services/sessions/storage.ts';
import { filesContext, filesReply } from '../../files/files.server.ts';
import type { RequestHandler } from './$types';

/** POST /api/machines/<id>/storage/rescan: Rescan now (SPEC-STORAGE Q7), audited. */
export const POST: RequestHandler = route.user(async (event, { user }) =>
	filesReply(await requestRescan(filesContext(event, user)))
);
