import { createUserRequestSchema } from '#lib/schemas/users/users.ts';
import { database } from '#lib/server/database/app-database.ts';
import { env } from '#lib/server/env.ts';
import { route } from '#lib/server/guards/route.ts';
import { wakeEmailWorker } from '#lib/server/services/email/email-worker.ts';
import { addUserAndInvite } from '#lib/server/services/users/invitations.ts';
import { listUsers } from '#lib/server/services/users/users.ts';
import { invalidRequest, readJson } from '../replies.server.ts';
import type { RequestHandler } from './$types';

/** GET /api/users: everyone who can sign in (admins). */
export const GET: RequestHandler = route.admin(() => Response.json({ users: listUsers(database) }));

/**
 * POST /api/users: add someone (SPEC-SIGN-IN S12) and tell them how to sign
 * in (SPEC-EMAIL E5): emailed when email is set up, otherwise a link the
 * admin passes on.
 */
export const POST: RequestHandler = route.admin(async ({ request, url }, { user }) => {
	const parsed = createUserRequestSchema.safeParse(await readJson(request));
	if (!parsed.success) {
		return invalidRequest(parsed.error);
	}
	const result = await addUserAndInvite(
		database,
		user,
		parsed.data,
		{ secretsKey: env.secretsKey, adminOrigin: url.origin },
		Date.now()
	);
	if (result.kind === 'refused') {
		return Response.json({ message: result.message }, { status: result.status });
	}
	wakeEmailWorker();
	return Response.json({ user: result.user, invitation: result.invitation }, { status: 201 });
});
