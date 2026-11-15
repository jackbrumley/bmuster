import { route } from '#lib/server/guards/route.ts';
import { finishSend } from '#lib/server/services/sessions/session-files.ts';
import { sendFinishRequestSchema } from '#lib/schemas/session-files/session-files.ts';
import { invalidRequest, readJson } from '../../../../../replies.server.ts';
import { sessionFilesContext, sessionFilesReply } from '../../session-files.server.ts';
import type { RequestHandler } from './$types';

/** POST /api/machines/<id>/session-files/send/finish: the drop is over: the tray notice at the machine (SPEC-SESSION-FILES 4.8). */
export const POST: RequestHandler = route.user(async (event, { user }) => {
	const parsed = sendFinishRequestSchema.safeParse(await readJson(event.request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	return sessionFilesReply(
		await finishSend(
			sessionFilesContext(event, user),
			parsed.data.batchId,
			parsed.data.shareClipboard
		)
	);
});
