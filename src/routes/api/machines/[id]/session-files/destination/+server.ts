import { route } from '#lib/server/guards/route.ts';
import { sendTarget } from '#lib/server/services/sessions/session-files.ts';
import {
	desktopSessionOf,
	sessionFilesContext,
	sessionFilesReply
} from '../session-files.server.ts';
import type { RequestHandler } from './$types';

/** GET /api/machines/<id>/session-files/destination?desktopSessionId=: the drop overlay's words (SPEC-SESSION-FILES 3.1). */
export const GET: RequestHandler = route.user(async (event, { user }) => {
	const query = desktopSessionOf(event);
	return query.kind === 'invalid'
		? query.reply
		: sessionFilesReply(await sendTarget(sessionFilesContext(event, user), query.desktopSessionId));
});
