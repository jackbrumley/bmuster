import { route } from '#lib/server/guards/route.ts';
import { sessionRelay } from '#lib/server/services/sessions/relay.ts';
import { browserTicketFor } from '#lib/server/services/sessions/sessions.ts';
import type { RequestHandler } from './$types';

/**
 * POST /api/sessions/<id>/browser-ticket: a fresh single-use ticket so a
 * reloaded page reattaches to its own running session (AGENTS.md §13), or
 * how the session ended once it is over.
 */
export const POST: RequestHandler = route.user(({ params }, { user }) =>
	Response.json(browserTicketFor(sessionRelay(), user, params.id))
);
