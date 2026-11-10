import { route } from '#lib/server/guards/route.ts';
import { testChannel } from '#lib/server/services/agents/test-builds-live.ts';
import { serverUpdates } from '#lib/server/services/server-updates/live.ts';
import type { RequestHandler } from './$types';
/** Check now: the server's own release, and the Test channel's builds (SPEC-TEST-CHANNEL). */
export const POST: RequestHandler = route.admin(async (_event, { user }) => {
	const now = Date.now();
	await Promise.all([serverUpdates().check(user.id, now), testChannel().check(now)]);
	return Response.json(serverUpdates().view(), { headers: { 'cache-control': 'no-store' } });
});
