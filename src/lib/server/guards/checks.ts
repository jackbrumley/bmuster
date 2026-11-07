import { error, redirect, type RequestEvent } from '@sveltejs/kit';
import type { ConsoleUser } from '#lib/domain/users/user.ts';

/** What the session hook proved about the request. */
export type SessionContext = { user: ConsoleUser };

export type Access = 'user' | 'admin';

/** For pages: not signed in → the sign-in page (coming back here after); a member on an admin page → 403. */
export function requirePageAccess(event: RequestEvent, access: Access): SessionContext {
	const session = event.locals.session;
	if (session.kind === 'none') {
		const returnTo = `${event.url.pathname}${event.url.search}`;
		redirect(303, `/login?returnTo=${encodeURIComponent(returnTo)}`);
	}
	if (access === 'admin' && session.user.role !== 'admin') {
		error(403, 'Only admins can open this page.');
	}
	return { user: session.user };
}

/** For endpoints: 401 without a session, 403 for a member on an admin endpoint. JSON `{ message }`. */
export function apiRefusal(event: RequestEvent, access: Access): Response | SessionContext {
	const session = event.locals.session;
	switch (session.kind) {
		case 'none':
			return Response.json({ message: 'Sign in first.' }, { status: 401 });
		case 'signed-in':
			if (access === 'admin' && session.user.role !== 'admin') {
				return Response.json({ message: 'Only admins can do this.' }, { status: 403 });
			}
			return { user: session.user };
	}
}
