import { database } from '#lib/server/database/app-database.ts';
import { route } from '#lib/server/guards/route.ts';
import { SESSION_COOKIE } from '#lib/server/services/auth/sessions.ts';
import { machineFeedStream } from '#lib/server/services/machines/machine-feed.ts';
import type { RequestHandler } from './$types';

/**
 * GET /api/machines/events: machine status as it changes, for the Machines
 * list and the machine header (SPEC-PRESENCE P5). Server-sent events; only
 * machines the person can see, checked on every event.
 */
export const GET: RequestHandler = route.user(({ cookies }) => {
	const token = cookies.get(SESSION_COOKIE) ?? '';
	return new Response(machineFeedStream(database, token), {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache, no-transform',
			// nginx would otherwise hold the events back in its buffer.
			'x-accel-buffering': 'no'
		}
	});
});
