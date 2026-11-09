import { z } from 'zod';
import { stableVersionSchema } from '#lib/schemas/releases/server-updates.ts';
import { route } from '#lib/server/guards/route.ts';
import { serverUpdates } from '#lib/server/services/server-updates/live.ts';
import { invalidRequest, readJson } from '../../replies.server.ts';
import type { RequestHandler } from './$types';
const requestSchema = z.strictObject({ version: stableVersionSchema });
/**
 * Update now (SPEC-SERVER-UPDATES SU2): admins only, origin-checked by the hooks. It writes the
 * empty request flag for the root updater and nothing else; `version` is what the admin confirmed.
 */
export const POST: RequestHandler = route.admin(async ({ request }, { user }) => {
	const parsed = requestSchema.safeParse(await readJson(request));
	if (!parsed.success) return invalidRequest(parsed.error);
	const now = Date.now();
	try {
		serverUpdates().request(parsed.data.version, user.id, now);
	} catch (error) {
		return Response.json(
			{ message: error instanceof Error ? error.message : String(error) },
			{ status: 409, headers: { 'cache-control': 'no-store' } }
		);
	}
	return Response.json(
		{ requestedAtIso: new Date(now).toISOString(), view: serverUpdates().view() },
		{ status: 202, headers: { 'cache-control': 'no-store' } }
	);
});
