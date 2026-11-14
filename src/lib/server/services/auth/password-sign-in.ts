import type { ConsoleUser } from '#lib/domain/users/user.ts';
import type { AppDatabase } from '../../database/connection.ts';
import { recordAudit } from '../audit/audit.ts';
import { findUserByEmail, toConsoleUser } from '../users/users.ts';
import type { SignInClient } from './client.ts';
import { verifyDecoy, verifyPassword } from './passwords.ts';
import type { StartedSession } from './sessions.ts';
import { startChallenge, type StartedChallenge } from './sign-in-challenges.ts';
import { PAUSED, recordSignInFailure, signInPause } from './sign-in-limits.ts';
import { finishSignIn, secondStepFor } from './sign-in-steps.ts';

/**
 * Password sign-in (SPEC-SIGN-IN S3, S4, S11). Every refusal for a wrong
 * email, wrong password, no password or a disabled account gives the same
 * message, so the reply never says which part was wrong. Admins can always
 * use a password (break-glass); anyone else only if an admin set one. With a
 * second step to go (SPEC-TWO-FACTOR 2.2) a right password starts a challenge,
 * not a session, and clears no failed attempts.
 */
export const WRONG_DETAILS = 'That email and password do not match an account here.';

export type PasswordSignIn =
	| { kind: 'signed-in'; user: ConsoleUser; session: StartedSession }
	| { kind: 'second-step'; challenge: StartedChallenge }
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

	const step = secondStepFor(database, user);
	if (step !== 'none') {
		return {
			kind: 'second-step',
			challenge: startChallenge(database, user.id, step, client, now)
		};
	}
	const session = database.transaction((transaction) =>
		finishSignIn(transaction, user, 'password', client, now)
	);
	return { kind: 'signed-in', user: toConsoleUser(user), session };
}
