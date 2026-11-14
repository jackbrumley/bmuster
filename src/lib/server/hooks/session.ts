import type { Handle } from '@sveltejs/kit/hooks';
import { database } from '../database/app-database.ts';
import { isAgentPath } from '../guards/agent-paths.ts';
import { isBearerPath } from '../guards/bearer-paths.ts';
import { authenticateSession } from '../services/auth/current-user.ts';
import { SESSION_COOKIE } from '../services/auth/sessions.ts';

/** Reads the session cookie into `locals.session`; drops a cookie whose session has ended. */
export const session: Handle = ({ event, resolve }) => {
	event.locals.session = { kind: 'none' };
	// Agents and AI assistants carry their own credentials; the console cookie is ignored (SPEC-MCP M4).
	if (isAgentPath(event.url.pathname) || isBearerPath(event.url.pathname)) {
		return resolve(event);
	}
	const token = event.cookies.get(SESSION_COOKIE);
	if (token !== undefined) {
		const user = authenticateSession(database, token, Date.now());
		if (user === undefined) {
			event.cookies.delete(SESSION_COOKIE, { path: '/' });
		} else {
			event.locals.session = { kind: 'signed-in', user };
		}
	}
	return resolve(event);
};
