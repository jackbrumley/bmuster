import type { Queryable } from '../../database/connection.ts';
import { recordAudit } from '../audit/audit.ts';
import { markSignedIn, type UserRow } from '../users/users.ts';
import type { SignInClient } from './client.ts';
import { pruneSessions, startSession, type StartedSession } from './sessions.ts';
import { endChallenges, startChallenge, type StartedChallenge } from './sign-in-challenges.ts';
import { clearSignInFailures } from './sign-in-limits.ts';
import { isTwoFactorOn, requiredFor } from './two-factor.ts';

/**
 * What follows a right password (SPEC-TWO-FACTOR 2.2): the code step when two-factor is on,
 * the set-up step when the setting requires it and it is not set up, or nothing. One place
 * decides, so a later second factor (passkeys) is one more case here.
 */
export function secondStepFor(
	database: Queryable,
	user: Pick<UserRow, 'id' | 'role'>
): 'none' | 'code' | 'set-up' {
	if (isTwoFactorOn(database, user.id)) {
		return 'code';
	}
	return requiredFor(database, user) ? 'set-up' : 'none';
}

/** After a right password: a console session now, or a challenge for the second step. */
export type SignInNext =
	{ kind: 'session'; session: StartedSession } | { kind: 'challenge'; challenge: StartedChallenge };

/**
 * For first-run setup and invitations, which audit the password themselves: the session, or
 * the step to take first.
 */
export function sessionOrChallenge(
	database: Queryable,
	user: Pick<UserRow, 'id' | 'role'>,
	client: SignInClient,
	now: number
): SignInNext {
	const step = secondStepFor(database, user);
	return step === 'none'
		? { kind: 'session', session: startSession(database, user.id, client, now) }
		: { kind: 'challenge', challenge: startChallenge(database, user.id, step, client, now) };
}

/**
 * A finished password sign-in, with or without a second step: the email's failed attempts
 * are cleared only now (TF6), the sign-in is audited with how it was made, and the session
 * starts.
 */
export function finishSignIn(
	database: Queryable,
	user: Pick<UserRow, 'id' | 'email'>,
	method: string,
	client: SignInClient,
	now: number
): StartedSession {
	clearSignInFailures(database, user.email);
	endChallenges(database, user.id);
	pruneSessions(database, now);
	markSignedIn(database, user.id, now);
	recordAudit(
		database,
		{
			actor: { kind: 'user', userId: user.id },
			kind: 'sign-in',
			target: user.email,
			machineId: null,
			detail: { method, ip: client.ip }
		},
		now
	);
	return startSession(database, user.id, client, now);
}
