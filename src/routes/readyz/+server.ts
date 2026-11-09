import { CHANGELOG } from '#lib/domain/releases/changelog.ts';
import { database } from '#lib/server/database/app-database.ts';
import { MIGRATIONS_FOLDER } from '#lib/server/database/connection.ts';
import { databaseReadiness } from '#lib/server/database/readiness.ts';
import { route } from '#lib/server/guards/route.ts';
import { serverLog } from '#lib/server/services/logs/server-log.ts';
import type { RequestHandler } from './$types';

/**
 * GET /readyz (SPEC-SERVER-INSTALL I14): the database answers and every
 * migration is applied. The installers wait on it before printing the
 * address. The reason for a 503 goes to the log, not to the caller.
 */
export const GET: RequestHandler = route.public(() => {
	const readiness = databaseReadiness(database, MIGRATIONS_FOLDER);
	const headers = { 'cache-control': 'no-store' };
	switch (readiness.kind) {
		case 'ready':
			return Response.json({ status: 'ready', version: CHANGELOG[0].version }, { headers });
		case 'not-ready':
			serverLog('warn', 'database', `GET /readyz: not ready (${readiness.reason})`);
			return Response.json({ status: 'not-ready' }, { status: 503, headers });
	}
});
