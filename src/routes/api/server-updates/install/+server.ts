import { z } from 'zod';
import { stableVersionSchema } from '#lib/schemas/releases/server-updates.ts';
import { route } from '#lib/server/guards/route.ts';
import { serverUpdates } from '#lib/server/services/server-updates/live.ts';
import { invalidRequest, readJson } from '../../replies.server.ts';
import type { RequestHandler } from './$types';
const requestSchema = z.strictObject({ version: stableVersionSchema });
export const POST: RequestHandler = route.admin(async ({ request }, { user }) => {
	const parsed = requestSchema.safeParse(await readJson(request));
	if (!parsed.success) return invalidRequest(parsed.error);
	try {
		serverUpdates().request(parsed.data.version, user.id, Date.now());
	} catch (error) {
		return Response.json(
			{ message: error instanceof Error ? error.message : String(error) },
			{ status: 409, headers: { 'cache-control': 'no-store' } }
		);
	}
	return Response.json(serverUpdates().view(), {
		status: 202,
		headers: { 'cache-control': 'no-store' }
	});
});
