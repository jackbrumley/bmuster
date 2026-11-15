import { route } from '#lib/server/guards/route.ts';
import { cancelSend } from '#lib/server/services/sessions/session-files.ts';
import { sendCancelRequestSchema } from '#lib/schemas/session-files/session-files.ts';
import { invalidRequest, readJson } from '../../../../../replies.server.ts';
import { sessionFilesContext, sessionFilesReply } from '../../session-files.server.ts';
import type { RequestHandler } from './$types';

/** POST /api/machines/<id>/session-files/send/cancel: removes a file's unfinished part (SPEC-SESSION-FILES 4.8). */
export const POST: RequestHandler = route.user(async (event, { user }) => {
	const parsed = sendCancelRequestSchema.safeParse(await readJson(event.request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	return sessionFilesReply(
		await cancelSend(sessionFilesContext(event, user), parsed.data.transferId)
	);
});
