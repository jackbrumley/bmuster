import { redirect } from '@sveltejs/kit';
import { database } from '#lib/server/database/app-database.ts';
import { route } from '#lib/server/guards/route.ts';
import { SESSION_COOKIE, signOut } from '#lib/server/services/auth/sessions.ts';
import type { RequestHandler } from './$types';

/** POST /logout: ends this session (SPEC-SIGN-IN S6). Sent by the sign-out form in the console frame. */
export const POST: RequestHandler = route.user(({ cookies }, { user }) => {
	const token = cookies.get(SESSION_COOKIE);
	if (token !== undefined) {
		signOut(database, token, user.id, user.email, Date.now());
	}
	cookies.delete(SESSION_COOKIE, { path: '/' });
	redirect(303, '/login');
});
