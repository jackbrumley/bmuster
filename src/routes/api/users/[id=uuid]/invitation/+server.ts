import { database } from '#lib/server/database/app-database.ts';
import { env } from '#lib/server/env.ts';
import { route } from '#lib/server/guards/route.ts';
import { wakeEmailWorker } from '#lib/server/services/email/email-worker.ts';
import { inviteUser } from '#lib/server/services/users/invitations.ts';
import type { RequestHandler } from './$types';

/**
 * POST /api/users/<id>/invitation: a new invitation for someone with no
 * password yet (SPEC-EMAIL E5); their earlier links stop working.
 */
export const POST: RequestHandler = route.admin(({ params, url }, { user }) => {
	const result = inviteUser(
		database,
		user,
		params.id,
		{ secretsKey: env.secretsKey, adminOrigin: url.origin },
		Date.now()
	);
	if (result.kind === 'refused') {
		return Response.json({ message: result.message }, { status: result.status });
	}
	wakeEmailWorker();
	return Response.json({ invitation: result.invitation });
});
