import { serverLogQuerySchema } from '#lib/schemas/logs/logs.ts';
import { database } from '#lib/server/database/app-database.ts';
import { route } from '#lib/server/guards/route.ts';
import { readServerLog } from '#lib/server/services/logs/diagnostics-reads.ts';
import { invalidRequest } from '../../../replies.server.ts';
import { noStore, readerOf, windowParams } from '../../diagnostics.server.ts';
import type { RequestHandler } from './$types';

/**
 * GET /api/diagnostics/server/logs?since&until&level&area&cursor&limit: the server's own log
 * records, newest first (SPEC-AGENT-LOGS 4). Admins and tokens; audited without the contents.
 */
export const GET: RequestHandler = route.diagnostics(({ url }, { reader }) => {
	const parsed = serverLogQuerySchema.safeParse({
		...windowParams(url),
		area: url.searchParams.get('area')
	});
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	return noStore(readServerLog(database, readerOf(reader), parsed.data, Date.now()));
});
