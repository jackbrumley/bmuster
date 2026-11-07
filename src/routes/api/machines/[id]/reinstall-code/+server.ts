import { error } from '@sveltejs/kit';
import { database } from '#lib/server/database/app-database.ts';
import { route } from '#lib/server/guards/route.ts';
import { createReinstallCode } from '#lib/server/services/agents/join-codes.ts';
import type { RequestHandler } from './$types';

/**
 * POST /api/machines/<id>/reinstall-code: a single-use, 60-minute code that
 * reinstalls this machine's agent into its existing entry (SPEC-MACHINE-DETAILS D9). Admins.
 */
export const POST: RequestHandler = route.admin(({ params }, { user }) => {
	const created = createReinstallCode(database, params.id, user.id, Date.now());
	if (created === undefined) {
		error(404, 'No machine with this id');
	}
	return Response.json({
		id: created.id,
		code: created.code,
		expiresAtIso: created.expiresAt.toISOString(),
		maxUses: created.maxUses
	});
});
