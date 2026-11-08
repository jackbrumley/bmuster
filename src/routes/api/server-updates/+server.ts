import { route } from '#lib/server/guards/route.ts';
import { serverUpdates } from '#lib/server/services/server-updates/live.ts';
import type { RequestHandler } from './$types';
export const GET: RequestHandler = route.admin(() =>
	Response.json(serverUpdates().view(), { headers: { 'cache-control': 'no-store' } })
);
