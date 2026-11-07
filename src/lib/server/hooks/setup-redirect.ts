import { redirect } from '@sveltejs/kit';
import type { Handle } from '@sveltejs/kit/hooks';
import { database } from '../database/app-database.ts';
import { isAgentPath } from '../guards/agent-paths.ts';
import { hasUsers } from '../services/users/users.ts';

/**
 * First run (SPEC-SIGN-IN S1): while there are no users, every page goes to
 * /setup. Users are never deleted, so once one exists the answer is kept.
 */
let setupDone = false;

export function needsSetupRedirect(pathname: string, usersExist: boolean): boolean {
	if (usersExist) {
		return false;
	}
	return (
		pathname !== '/setup' &&
		// Health probes (SPEC-SERVER-INSTALL I14) must answer before setup too.
		pathname !== '/healthz' &&
		pathname !== '/readyz' &&
		!pathname.startsWith('/api/') &&
		!pathname.startsWith('/_app/') &&
		!isAgentPath(pathname)
	);
}

export const setupRedirect: Handle = ({ event, resolve }) => {
	if (!setupDone) {
		setupDone = hasUsers(database);
	}
	if (needsSetupRedirect(event.url.pathname, setupDone)) {
		redirect(303, '/setup');
	}
	return resolve(event);
};
