import { eq } from 'drizzle-orm';
import type { SignInCheck } from '#lib/domain/auth/sign-in-check.ts';
import { consoleSessions } from '../../database/schema.ts';
import type { AppDatabase, Queryable } from '../../database/connection.ts';
import { recordAudit } from '../audit/audit.ts';
import { findUserById } from '../users/users.ts';
import { verifyPassword } from './passwords.ts';
import { hashSessionToken } from './sessions.ts';
import { clearSignInFailures } from './sign-in-limits.ts';
import {
	isTwoFactorOn,
	pausedRefusal,
	recordWrongAnswer,
	verifySecondFactor
} from './two-factor.ts';

/**
 * Recent sign-in (SPEC-COMMANDS C10), for anything that should not run on a browser someone
 * walked away from. The sign-in itself is the first check (`createdAt`): a password or a fresh
 * single sign-on. After that, typing the password again in the same session is (`reconfirmedAt`),
 * or, with two-factor on, a code from the authenticator app instead (SPEC-TWO-FACTOR 2.7): it is
 * the factor a walk-up person lacks, while the browser may fill the password in for them.
 * Recovery codes are not accepted here. A wrong answer counts toward the sign-in pauses
 * (SPEC-SIGN-IN S4), as at the sign-in page.
 */

const WRONG_PASSWORD = 'That password is not right.';
const WRONG_CODE =
	'That code is not right. Type the 6-digit code your authenticator app shows now. Lost your phone? Sign out, then sign in with a recovery code.';
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
	if (user === undefined || user.passwordHash === null) {
		return { kind: 'sign-in-again' };
	}
	return isTwoFactorOn(database, userId) ? { kind: 'code' } : { kind: 'password' };
}

export type Reconfirmed =
	{ kind: 'confirmed' } | { kind: 'refused'; status: 403 | 429; message: string };

/** What the person typed for the check: their password, or a code with two-factor on. */
export type Recheck = { kind: 'password'; password: string } | { kind: 'code'; code: string };

/**
 * Checks it is still the person, for this session: the password, or with two-factor on an
 * authenticator code. A wrong answer is a sign-in failure for their email and address (pauses
 * after 5 and 20); a right one clears their failures and makes the session recent.
 */
export async function reconfirmSignIn(
	database: AppDatabase,
	secretsKey: Buffer,
	attempt: { token: string; userId: string; recheck: Recheck; ip: string },
	now: number
): Promise<Reconfirmed> {
	const user = findUserById(database, attempt.userId);
	if (user === undefined || user.passwordHash === null) {
		return { kind: 'refused', status: 403, message: SIGN_IN_AGAIN };
	}
	const twoFactor = isTwoFactorOn(database, user.id);
	const method = twoFactor ? 'authenticator code check' : 'password check';
	const paused = pausedRefusal(database, user, attempt.ip, method, now);
	if (paused !== undefined) {
		return { kind: 'refused', status: 429, message: paused.message };
	}
	const recheck = attempt.recheck;
	if (twoFactor) {
		const right =
			recheck.kind === 'code' &&
			verifySecondFactor(database, secretsKey, user.id, recheck.code, 'code-only', now).kind ===
				'code';
		if (!right) {
			recordWrongAnswer(database, user, attempt.ip, { method, reason: 'wrong-code' }, now);
			return { kind: 'refused', status: 403, message: WRONG_CODE };
		}
	} else {
		const right =
			recheck.kind === 'password' && (await verifyPassword(user.passwordHash, recheck.password));
		if (!right) {
			recordWrongAnswer(database, user, attempt.ip, { method, reason: 'wrong-password' }, now);
			return { kind: 'refused', status: 403, message: WRONG_PASSWORD };
		}
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
				kind: twoFactor ? 'code-confirmed' : 'password-confirmed',
				target: user.email,
				machineId: null,
				detail: { ip: attempt.ip }
			},
			now
		);
	});
	return { kind: 'confirmed' };
}
