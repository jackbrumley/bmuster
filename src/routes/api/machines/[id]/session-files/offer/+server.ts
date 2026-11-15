import { route } from '#lib/server/guards/route.ts';
import { clipboardOffer } from '#lib/server/services/sessions/session-files.ts';
import { targetQuerySchema } from '#lib/schemas/session-files/session-files.ts';
import { invalidRequest } from '../../../../replies.server.ts';
import { sessionFilesContext, sessionFilesReply } from '../session-files.server.ts';
import type { RequestHandler } from './$types';

/**
 * GET /api/machines/<id>/session-files/offer?desktopSessionId=: the files copied on the machine
 * now, by name and size (SPEC-SESSION-FILES 3.2). Asked while Share clipboard is on, or once by
 * Get copied files.
 */
export const GET: RequestHandler = route.user(async (event, { user }) => {
	const query = targetQuerySchema.safeParse({
		desktopSessionId: event.url.searchParams.get('desktopSessionId') ?? ''
	});
	if (!query.success) {
		return invalidRequest(query.error);
	}
	return sessionFilesReply(
		await clipboardOffer(sessionFilesContext(event, user), query.data.desktopSessionId)
	);
});
