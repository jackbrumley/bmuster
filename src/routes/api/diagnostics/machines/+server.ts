import { database } from '#lib/server/database/app-database.ts';
import { env } from '#lib/server/env.ts';
import { route } from '#lib/server/guards/route.ts';
import { signedReleases } from '#lib/server/services/agents/releases.ts';
import { diagnosticsMachines } from '#lib/server/services/logs/diagnostics-reads.ts';
import { noStore } from '../diagnostics.server.ts';
import type { RequestHandler } from './$types';

/** GET /api/diagnostics/machines: every machine, briefly (SPEC-AGENT-LOGS 4). Admins and tokens. */
export const GET: RequestHandler = route.diagnostics(() =>
	noStore({ machines: diagnosticsMachines(database, Date.now(), signedReleases(env.releasesPath)) })
);
