import { database } from '#lib/server/database/app-database.ts';
import { route } from '#lib/server/guards/route.ts';
import { SESSION_COOKIE } from '#lib/server/services/auth/sessions.ts';
import { liveStream } from '#lib/server/services/live/live-events.ts';
import type { RequestHandler } from './$types';

/**
 * GET /api/live (SPEC-MCP 10.3): the console's live channel, as server-sent events. Each event
 * is written for the person listening (an approval request reaches only people who may decide
 * it), and the session is checked again on every event.
 */
export const GET: RequestHandler = route.user(({ cookies }) => {
	const token = cookies.get(SESSION_COOKIE) ?? '';
	return new Response(liveStream(database, token, Date.now), {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache, no-transform',
			// nginx would otherwise hold the events back in its buffer.
			'x-accel-buffering': 'no'
		}
	});
});
