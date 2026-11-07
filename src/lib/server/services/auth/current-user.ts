import type { ConsoleUser } from '#lib/domain/users/user.ts';
import type { Queryable } from '../../database/connection.ts';
import { findUserById, toConsoleUser } from '../users/users.ts';
import { endSession, findSession } from './sessions.ts';

/**
 * The person behind a session cookie, or undefined. A disabled person's
 * session is ended here too, in case one outlived the disable.
 */
export function authenticateSession(
	database: Queryable,
	token: string,
	now: number
): ConsoleUser | undefined {
	const session = findSession(database, token, now);
	switch (session.kind) {
		case 'none':
			return undefined;
		case 'active': {
			const user = findUserById(database, session.userId);
			if (user?.disabledAt !== null) {
				endSession(database, token);
				return undefined;
			}
			return toConsoleUser(user);
		}
	}
}
