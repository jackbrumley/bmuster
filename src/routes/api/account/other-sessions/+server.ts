import { database } from '#lib/server/database/app-database.ts';
import { route } from '#lib/server/guards/route.ts';
import { SESSION_COOKIE, signOutOtherSessions } from '#lib/server/services/auth/sessions.ts';
import type { RequestHandler } from './$types';

/**
 * DELETE /api/account/other-sessions: "Sign out everywhere else" (SPEC-SIGN-IN S21). Ends the
 * person's other console sessions and keeps the one this request came with; AI assistant
 * connections are untouched. The origin hook refuses it from another site.
 */
export const DELETE: RequestHandler = route.user(({ cookies }, { user }) => {
	const token = cookies.get(SESSION_COOKIE);
	if (token === undefined) {
		return Response.json({ message: 'Sign in again.' }, { status: 401 });
	}
	const ended = signOutOtherSessions(database, token, user, Date.now());
	return Response.json({ ended });
});
