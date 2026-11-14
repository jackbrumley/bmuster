import { database } from '#lib/server/database/app-database.ts';
import { env } from '#lib/server/env.ts';
import { route } from '#lib/server/guards/route.ts';
import { startTotpSetUp } from '#lib/server/services/auth/two-factor.ts';
import { findUserById } from '#lib/server/services/users/users.ts';
import type { RequestHandler } from './$types';

/**
 * POST /api/account/two-factor/set-up: the key to scan (TF2, TF9), the same pending one for an
 * hour. Refused once two-factor is on, so the key is never sent again.
 */
export const POST: RequestHandler = route.user((_event, { user }) => {
	const row = findUserById(database, user.id);
	if (row === undefined) {
		return Response.json({ message: 'No user with this id.' }, { status: 404 });
	}
	const result = startTotpSetUp(database, env.secretsKey, row, Date.now());
	return result.kind === 'started'
		? Response.json({ key: result.key })
		: Response.json({ message: result.message }, { status: result.status });
});
