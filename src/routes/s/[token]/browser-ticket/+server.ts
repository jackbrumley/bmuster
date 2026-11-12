import { route } from '#lib/server/guards/route.ts';
import { sessionRelay } from '#lib/server/services/sessions/relay.ts';
import { guestBrowserTicket } from '#lib/server/services/share-links/guest-sessions.ts';
import { guestTicketRequestSchema } from '#lib/schemas/share-links/share-links.ts';
import { invalidRequest, readJson } from '../../../api/replies.server.ts';
import type { RequestHandler } from './$types';

/**
 * POST /s/<token>/browser-ticket: a fresh single-use ticket so a reloaded
 * guest page reattaches to the link's own running session, or how it ended.
 */
export const POST: RequestHandler = route.guest(async (event, { grant }) => {
	const parsed = guestTicketRequestSchema.safeParse(await readJson(event.request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	return Response.json(guestBrowserTicket(sessionRelay(), grant, parsed.data.sessionId));
});
