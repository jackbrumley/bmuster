import { error } from '@sveltejs/kit';
import { sessionsQuerySchema } from '#lib/schemas/logs/checks.ts';
import { database } from '#lib/server/database/app-database.ts';
import { route } from '#lib/server/guards/route.ts';
import { readMachineSessions } from '#lib/server/services/logs/machine-sessions.ts';
import { invalidRequest } from '../../../../replies.server.ts';
import { noStore, readerOf } from '../../../diagnostics.server.ts';
import type { RequestHandler } from './$types';

/**
 * GET /api/diagnostics/machines/<id>/sessions?since&limit: the machine's sessions, newest first,
 * each with the timeline and desktop figures its agent shipped (SPEC-DIAGNOSTICS 3). Admins and
 * tokens; audited with the count.
 */
export const GET: RequestHandler = route.diagnostics(({ params, url }, { reader }) => {
	const parsed = sessionsQuerySchema.safeParse({
		since: url.searchParams.get('since'),
		limit: url.searchParams.get('limit')
	});
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	const sessions = readMachineSessions(
		database,
		readerOf(reader),
		params.id,
		parsed.data,
		Date.now()
	);
	if (sessions === undefined) {
		error(404, 'No machine with this id');
	}
	return noStore({ sessions });
});
