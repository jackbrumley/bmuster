import { eq } from 'drizzle-orm';
import type { SignInCheck } from '#lib/domain/auth/sign-in-check.ts';
import { consoleSessions } from '../../database/schema.ts';
import type { AppDatabase, Queryable } from '../../database/connection.ts';
import { recordAudit } from '../audit/audit.ts';
import { findUserById } from '../users/users.ts';
import { verifyPassword } from './passwords.ts';
import { PAUSED } from './password-sign-in.ts';
import { hashSessionToken } from './sessions.ts';
import { clearSignInFailures, recordSignInFailure, signInPause } from './sign-in-limits.ts';

/**
 * Recent sign-in (SPEC-COMMANDS C10), for anything that should not run on a browser someone
 * walked away from. The sign-in itself is the first check (`createdAt`): a password or a fresh
 * single sign-on. After that, typing the password again in the same session is (`reconfirmedAt`).
 * A wrong password counts toward the sign-in pauses (SPEC-SIGN-IN S4), as at the sign-in page.
 */

export const WRONG_PASSWORD = 'That password is not right.';
export const SIGN_IN_AGAIN =
	'You signed in more than 10 minutes ago. Sign out and sign in again, then run it.';

/** When this session last proved who is at the browser; undefined for an unknown session. */
function lastCheckAt(database: Queryable, token: string): number | undefined {
	const row = database
		.select({ createdAt: consoleSessions.createdAt, reconfirmedAt: consoleSessions.reconfirmedAt })
		.from(consoleSessions)
		.where(eq(consoleSessions.idHash, hashSessionToken(token)))
		.get();
	if (row === undefined) {
		return undefined;
	}
	return Math.max(row.createdAt.getTime(), row.reconfirmedAt?.getTime() ?? 0);
}

/** Whether the session behind `token` checked who it is within `withinMs`, and if not, how it can. */
export function signInCheck(
	database: Queryable,
	token: string,
	userId: string,
	withinMs: number,
	now: number
): SignInCheck {
	const at = lastCheckAt(database, token);
	if (at !== undefined && now - at <= withinMs) {
		return { kind: 'recent' };
	}
	const user = findUserById(database, userId);
	return user === undefined || user.passwordHash === null
		? { kind: 'sign-in-again' }
		: { kind: 'password' };
}

export type Reconfirmed =
	{ kind: 'confirmed' } | { kind: 'refused'; status: 403 | 429; message: string };

/**
 * Checks the person's password again for this session. A wrong one is a sign-in failure for
 * their email and address (pauses after 5 and 20); a right one clears their failures.
 */
export async function reconfirmPassword(
	database: AppDatabase,
	attempt: { token: string; userId: string; password: string; ip: string },
	now: number
): Promise<Reconfirmed> {
	const user = findUserById(database, attempt.userId);
	if (user === undefined || user.passwordHash === null) {
		return { kind: 'refused', status: 403, message: SIGN_IN_AGAIN };
	}
	const limits = { email: user.email, address: attempt.ip };
	const pause = signInPause(database, limits, now);
	if (pause.kind === 'paused') {
		recordAudit(
			database,
			{
				actor: { kind: 'user', userId: user.id },
				kind: 'sign-in-failed',
				target: user.email,
				machineId: null,
				detail: { method: 'password check', reason: `paused-${pause.by}`, ip: attempt.ip }
			},
			now
		);
		return { kind: 'refused', status: 429, message: PAUSED };
	}
	if (!(await verifyPassword(user.passwordHash, attempt.password))) {
		recordSignInFailure(database, limits, now);
		recordAudit(
			database,
			{
				actor: { kind: 'user', userId: user.id },
				kind: 'sign-in-failed',
				target: user.email,
				machineId: null,
				detail: { method: 'password check', reason: 'wrong-password', ip: attempt.ip }
			},
			now
		);
		return { kind: 'refused', status: 403, message: WRONG_PASSWORD };
	}
	database.transaction((transaction) => {
		clearSignInFailures(transaction, user.email);
		transaction
			.update(consoleSessions)
			.set({ reconfirmedAt: new Date(now) })
			.where(eq(consoleSessions.idHash, hashSessionToken(attempt.token)))
			.run();
		recordAudit(
			transaction,
			{
				actor: { kind: 'user', userId: user.id },
				kind: 'password-confirmed',
				target: user.email,
				machineId: null,
				detail: { ip: attempt.ip }
			},
			now
		);
	});
	return { kind: 'confirmed' };
}
