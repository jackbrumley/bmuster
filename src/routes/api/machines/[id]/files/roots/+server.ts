import { route } from '#lib/server/guards/route.ts';
import { listRoots } from '#lib/server/services/sessions/files.ts';
import { filesContext, filesReply } from '../files.server.ts';
import type { RequestHandler } from './$types';

/** GET /api/machines/<id>/files/roots: drives or mount points (SPEC-FILES F2). */
export const GET: RequestHandler = route.user(async (event, { user }) =>
	filesReply(await listRoots(filesContext(event, user)))
);
