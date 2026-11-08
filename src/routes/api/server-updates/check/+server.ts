import { route } from '#lib/server/guards/route.ts';
import { serverUpdates } from '#lib/server/services/server-updates/live.ts';
import type { RequestHandler } from './$types';
export const POST: RequestHandler = route.admin(async (_event, { user }) => {
	await serverUpdates().check(user.id, Date.now());
	return Response.json(serverUpdates().view(), { headers: { 'cache-control': 'no-store' } });
});
