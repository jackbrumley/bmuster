import { database } from '#lib/server/database/app-database.ts';
import { route } from '#lib/server/guards/route.ts';
import { SESSION_COOKIE } from '#lib/server/services/auth/sessions.ts';
import { runFeedStream } from '#lib/server/services/commands/command-feed.ts';
import { appRunner } from '../../../command-context.server.ts';
import type { RequestHandler } from './$types';

/**
 * GET /api/commands/runs/<id>/events: the run's rows as they change (SPEC-COMMANDS C16), as
 * server-sent events, the same way /api/machines/events streams presence.
 */
export const GET: RequestHandler = route.user(({ cookies, params }) => {
	const token = cookies.get(SESSION_COOKIE) ?? '';
	return new Response(runFeedStream(database, appRunner(), token, params.id), {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache, no-transform',
			// nginx would otherwise hold the events back in its buffer.
			'x-accel-buffering': 'no'
		}
	});
});
