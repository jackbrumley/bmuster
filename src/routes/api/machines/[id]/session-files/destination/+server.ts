import { route } from '#lib/server/guards/route.ts';
import { sendTarget } from '#lib/server/services/sessions/session-files.ts';
import { targetQuerySchema } from '#lib/schemas/session-files/session-files.ts';
import { invalidRequest } from '../../../../replies.server.ts';
import { sessionFilesContext, sessionFilesReply } from '../session-files.server.ts';
import type { RequestHandler } from './$types';

/** GET /api/machines/<id>/session-files/destination?desktopSessionId=: the drop overlay's words (SPEC-SESSION-FILES 3.1). */
export const GET: RequestHandler = route.user(async (event, { user }) => {
	const query = targetQuerySchema.safeParse({
		desktopSessionId: event.url.searchParams.get('desktopSessionId') ?? ''
	});
	if (!query.success) {
		return invalidRequest(query.error);
	}
	return sessionFilesReply(
		await sendTarget(sessionFilesContext(event, user), query.data.desktopSessionId)
	);
});
