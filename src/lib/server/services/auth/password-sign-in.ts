import type { ConsoleUser } from '#lib/domain/users/user.ts';
import type { AppDatabase } from '../../database/connection.ts';
import { recordAudit } from '../audit/audit.ts';
import { findUserByEmail, markSignedIn, toConsoleUser } from '../users/users.ts';
import type { SignInClient } from './client.ts';
import { verifyDecoy, verifyPassword } from './passwords.ts';
import { pruneSessions, startSession, type StartedSession } from './sessions.ts';
import { clearSignInFailures, recordSignInFailure, signInPause } from './sign-in-limits.ts';

/**
 * Password sign-in (SPEC-SIGN-IN S3, S4, S11). Every refusal for a wrong
 * email, wrong password, no password or a disabled account gives the same
 * message, so the reply never says which part was wrong. Admins can always
 * use a password (break-glass); anyone else only if an admin set one.
 */
export const WRONG_DETAILS = 'That email and password do not match an account here.';
export const PAUSED = 'Too many attempts. Wait a few minutes, then try again.';

export type PasswordSignIn =
	| { kind: 'signed-in'; user: ConsoleUser; session: StartedSession }
	| { kind: 'refused'; message: string };

export async function signInWithPassword(
	database: AppDatabase,
	attempt: { email: string; password: string },
	client: SignInClient,
	now: number
): Promise<PasswordSignIn> {
	const email = attempt.email.trim().toLowerCase();
	const limits = { email, address: client.ip };
	const pause = signInPause(database, limits, now);
	if (pause.kind === 'paused') {
		recordAudit(
			database,
			{
				actor: { kind: 'system' },
				kind: 'sign-in-failed',
				target: email,
				machineId: null,
				detail: { method: 'password', reason: `paused-${pause.by}`, ip: client.ip }
			},
			now
		);
		return { kind: 'refused', message: PAUSED };
	}

	const user = findUserByEmail(database, email);
	const matches =
		user !== undefined && user.passwordHash !== null
			? await verifyPassword(user.passwordHash, attempt.password)
			: await verifyDecoy(attempt.password);

	if (user === undefined || !matches || user.disabledAt !== null) {
		const reason =
			user === undefined
				? 'unknown-email'
				: user.passwordHash === null
					? 'no-password'
					: !matches
						? 'wrong-password'
						: 'disabled';
		recordSignInFailure(database, limits, now);
		recordAudit(
			database,
			{
				actor: user === undefined ? { kind: 'system' } : { kind: 'user', userId: user.id },
				kind: 'sign-in-failed',
				target: email,
				machineId: null,
				detail: { method: 'password', reason, ip: client.ip }
			},
			now
		);
		return { kind: 'refused', message: WRONG_DETAILS };
	}

	const session = database.transaction((transaction) => {
		clearSignInFailures(transaction, email);
		pruneSessions(transaction, now);
		markSignedIn(transaction, user.id, now);
		recordAudit(
			transaction,
			{
				actor: { kind: 'user', userId: user.id },
				kind: 'sign-in',
				target: email,
				machineId: null,
				detail: { method: 'password', ip: client.ip }
			},
			now
		);
		return startSession(transaction, user.id, client, now);
	});
	return { kind: 'signed-in', user: toConsoleUser(user), session };
}
