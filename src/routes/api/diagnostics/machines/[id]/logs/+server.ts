import { error } from '@sveltejs/kit';
import { agentLogQuerySchema } from '#lib/schemas/logs/logs.ts';
import { database } from '#lib/server/database/app-database.ts';
import { route } from '#lib/server/guards/route.ts';
import { readMachineLogs } from '#lib/server/services/logs/diagnostics-reads.ts';
import { invalidRequest } from '../../../../replies.server.ts';
import { noStore, readerOf, windowParams } from '../../../diagnostics.server.ts';
import type { RequestHandler } from './$types';

/**
 * GET /api/diagnostics/machines/<id>/logs?since&until&level&source&cursor&limit: the machine's
 * agent log records, newest first (SPEC-AGENT-LOGS 4). Admins and tokens; audited without the
 * contents.
 */
export const GET: RequestHandler = route.diagnostics(({ params, url }, { reader }) => {
	const parsed = agentLogQuerySchema.safeParse({
		...windowParams(url),
		source: url.searchParams.get('source')
	});
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	const page = readMachineLogs(database, readerOf(reader), params.id, parsed.data, Date.now());
	if (page === undefined) {
		error(404, 'No machine with this id');
	}
	return noStore(page);
});
