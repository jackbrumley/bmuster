import { route } from '#lib/server/guards/route.ts';
import { endSend } from '#lib/server/services/sessions/session-files.ts';
import { sendEndRequestSchema } from '#lib/schemas/session-files/session-files.ts';
import { invalidRequest, readJson } from '../../../../../replies.server.ts';
import { sessionFilesContext, sessionFilesReply } from '../../session-files.server.ts';
import type { RequestHandler } from './$types';

/** POST /api/machines/<id>/session-files/send/end: checks the whole file and saves it under a free name (audited) (SPEC-SESSION-FILES 4.8). */
export const POST: RequestHandler = route.user(async (event, { user }) => {
	const parsed = sendEndRequestSchema.safeParse(await readJson(event.request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	return sessionFilesReply(await endSend(sessionFilesContext(event, user), parsed.data));
});
