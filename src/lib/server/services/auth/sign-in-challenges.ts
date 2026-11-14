import { randomBytes } from 'node:crypto';
import { and, eq, lt } from 'drizzle-orm';
import { signInChallenges } from '../../database/schema.ts';
import type { Queryable } from '../../database/connection.ts';
import type { SignInClient } from './client.ts';
import { hashSessionToken } from './sessions.ts';

/**
 * The half-signed-in state (SPEC-TWO-FACTOR 2.3): a right password with a second step to go.
 * An opaque random token in its own cookie, scoped to /login; only its SHA-256 is stored. It
 * is not a session: no hook, guard or socket reads it, so it grants nothing but the step's page.
 */
export const CHALLENGE_COOKIE = 'bmuster_sign_in';

export const CHALLENGE_MS = 5 * 60_000;

export type SignInStep = 'code' | 'set-up';

export type StartedChallenge = { token: string; expiresAt: Date; step: SignInStep };

export type ChallengeCookieOptions = {
	path: '/login';
	httpOnly: true;
	secure: true;
	sameSite: 'lax';
	expires: Date;
};

export function challengeCookieOptions(expiresAt: Date): ChallengeCookieOptions {
	return { path: '/login', httpOnly: true, secure: true, sameSite: 'lax', expires: expiresAt };
}

/** Starts a challenge; the person's older ones, and everyone's expired ones, are deleted. */
export function startChallenge(
	database: Queryable,
	userId: string,
	step: SignInStep,
	client: SignInClient,
	now: number
): StartedChallenge {
	database
		.delete(signInChallenges)
		.where(lt(signInChallenges.expiresAt, new Date(now)))
		.run();
	endChallenges(database, userId);
	const token = randomBytes(32).toString('base64url');
	const expiresAt = new Date(now + CHALLENGE_MS);
	database
		.insert(signInChallenges)
		.values({
			idHash: hashSessionToken(token),
			userId,
			step,
			createdAt: new Date(now),
			expiresAt,
			ip: client.ip,
			userAgent: client.userAgent.slice(0, 300)
		})
		.run();
	return { token, expiresAt, step };
}

export type FoundChallenge = { kind: 'none' } | { kind: 'active'; userId: string };

/** The challenge behind a cookie, if it is for this step and has not run out. */
export function findChallenge(
	database: Queryable,
	token: string,
	step: SignInStep,
	now: number
): FoundChallenge {
	const row = database
		.select()
		.from(signInChallenges)
		.where(
			and(eq(signInChallenges.idHash, hashSessionToken(token)), eq(signInChallenges.step, step))
		)
		.get();
	if (row === undefined || row.expiresAt.getTime() <= now) {
		return { kind: 'none' };
	}
	return { kind: 'active', userId: row.userId };
}

/** Ends every challenge a person has: the sign-in finished, or their two-factor was reset. */
export function endChallenges(database: Queryable, userId: string): void {
	database.delete(signInChallenges).where(eq(signInChallenges.userId, userId)).run();
}
