import { route } from '#lib/server/guards/route.ts';
import type { RequestHandler } from './$types';

/**
 * GET /healthz (SPEC-SERVER-INSTALL I14): the process is up and serving
 * requests. For container platforms and monitoring; says nothing else.
 */
export const GET: RequestHandler = route.public(() =>
	Response.json({ status: 'alive' }, { headers: { 'cache-control': 'no-store' } })
);
