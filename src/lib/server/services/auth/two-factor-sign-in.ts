import type { TwoFactorKey } from '#lib/domain/auth/two-factor.ts';
import type { AppDatabase } from '../../database/connection.ts';
import { findUserById, type UserRow } from '../users/users.ts';
import type { SignInClient } from './client.ts';
import type { StartedSession } from './sessions.ts';
import { findChallenge, type SignInStep } from './sign-in-challenges.ts';
import { finishSignIn } from './sign-in-steps.ts';
import {
	confirmTotpSetUp,
	pausedRefusal,
	recordRecoveryCodeUse,
	recordWrongAnswer,
	startTotpSetUp,
	verifySecondFactor
} from './two-factor.ts';

/**
 * The two step pages after a right password (SPEC-TWO-FACTOR 2.4, 2.5). Each needs the
 * challenge cookie for its own step; an expired, used or unknown one is `timed-out`, and the
 * page sends the person back to sign in.
 */

const WRONG_CODE = 'That code is not right. Try the newest code from your app, or a recovery code.';

type Timed = { kind: 'timed-out' };

/** The person behind a live challenge for this step; a disabled person has no challenge. */
function challengedUser(
	database: AppDatabase,
	token: string,
	step: SignInStep,
	now: number
): UserRow | undefined {
	const found = findChallenge(database, token, step, now);
	if (found.kind === 'none') {
		return undefined;
	}
	const user = findUserById(database, found.userId);
	return user?.disabledAt !== null ? undefined : user;
}

/** The code step (TF5, TF6, TF10): an authenticator code or a recovery code. */
export function answerCodeStep(
	database: AppDatabase,
	secretsKey: Buffer,
	token: string,
	typed: string,
	client: SignInClient,
	now: number
): { kind: 'signed-in'; session: StartedSession } | Timed | { kind: 'refused'; message: string } {
	const user = challengedUser(database, token, 'code', now);
	if (user === undefined) {
		return { kind: 'timed-out' };
	}
	const paused = pausedRefusal(database, user, client.ip, 'authenticator code', now);
	if (paused !== undefined) {
		return { kind: 'refused', message: paused.message };
	}
	return database.transaction((transaction) => {
		const answer = verifySecondFactor(
			transaction,
			secretsKey,
			user.id,
			typed,
			'code-or-recovery',
			now
		);
		switch (answer.kind) {
			case 'wrong':
				recordWrongAnswer(
					transaction,
					user,
					client.ip,
					{ method: 'authenticator code', reason: 'wrong-code' },
					now
				);
				return { kind: 'refused', message: WRONG_CODE };
			case 'recovery':
				recordRecoveryCodeUse(transaction, user, 'signing in', answer.remaining, now);
				return {
					kind: 'signed-in',
					session: finishSignIn(transaction, user, 'password and recovery code', client, now)
				};
			case 'code':
				return {
					kind: 'signed-in',
					session: finishSignIn(transaction, user, 'password and authenticator code', client, now)
				};
		}
	});
}

/** What the set-up step shows (TF8, TF9): the pending key, the same one on every reload. */
export function setUpStepKey(
	database: AppDatabase,
	secretsKey: Buffer,
	token: string,
	now: number
): { kind: 'key'; key: TwoFactorKey; email: string } | Timed {
	const user = challengedUser(database, token, 'set-up', now);
	if (user === undefined) {
		return { kind: 'timed-out' };
	}
	const started = startTotpSetUp(database, secretsKey, user, now);
	// Refused only once it is on; the challenge was for set-up, so it has been used up.
	return started.kind === 'started'
		? { kind: 'key', key: started.key, email: user.email }
		: { kind: 'timed-out' };
}

/** The set-up step's first code: two-factor goes on, the session starts, codes shown once. */
export async function answerSetUpStep(
	database: AppDatabase,
	secretsKey: Buffer,
	token: string,
	typed: string,
	client: SignInClient,
	now: number
): Promise<
	| { kind: 'signed-in'; session: StartedSession; recoveryCodes: string[]; email: string }
	| Timed
	| { kind: 'refused'; message: string }
> {
	const user = challengedUser(database, token, 'set-up', now);
	if (user === undefined) {
		return { kind: 'timed-out' };
	}
	const result = await confirmTotpSetUp(
		database,
		secretsKey,
		user,
		{ code: typed, password: { kind: 'just-typed' } },
		{ ip: client.ip, where: 'sign-in' },
		now
	);
	if (result.kind === 'refused') {
		return { kind: 'refused', message: result.message };
	}
	const session = database.transaction((transaction) =>
		finishSignIn(transaction, user, 'password, then set up two-factor', client, now)
	);
	return { kind: 'signed-in', session, recoveryCodes: result.recoveryCodes, email: user.email };
}
