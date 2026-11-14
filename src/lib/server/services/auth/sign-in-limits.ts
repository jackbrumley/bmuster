import { and, count, eq, gt, lt, max, min } from 'drizzle-orm';
import { signInFailures } from '../../database/schema.ts';
import type { Queryable } from '../../database/connection.ts';

/**
 * Password guessing limits (SPEC-SIGN-IN S4, 7):
 * - 5 failures for one email within 15 minutes pause that email for 5 minutes
 *   after the latest failure, whichever address they came from;
 * - 20 failures from one address within 10 minutes pause that address until
 *   the oldest of them is 10 minutes old.
 * A paused attempt is refused before the password is checked.
 */
/** What a paused sign-in, code or password check is told. */
export const PAUSED = 'Too many attempts. Wait a few minutes, then try again.';

export const EMAIL_LIMIT = { failures: 5, windowMs: 15 * 60_000, pauseMs: 5 * 60_000 } as const;
export const ADDRESS_LIMIT = { failures: 20, windowMs: 10 * 60_000 } as const;

/** Failures older than this are deleted. */
const KEEP_MS = 24 * 60 * 60_000;

export type Pause = { kind: 'none' } | { kind: 'paused'; untilMs: number; by: 'email' | 'address' };

export function signInPause(
	database: Queryable,
	attempt: { email: string; address: string },
	now: number
): Pause {
	const byEmail = database
		.select({ total: count(), latest: max(signInFailures.failedAt) })
		.from(signInFailures)
		.where(
			and(
				eq(signInFailures.email, attempt.email),
				gt(signInFailures.failedAt, new Date(now - EMAIL_LIMIT.windowMs))
			)
		)
		.get();
	if (byEmail !== undefined && byEmail.total >= EMAIL_LIMIT.failures && byEmail.latest !== null) {
		const untilMs = byEmail.latest.getTime() + EMAIL_LIMIT.pauseMs;
		if (untilMs > now) {
			return { kind: 'paused', untilMs, by: 'email' };
		}
	}
	const byAddress = database
		.select({ total: count(), oldest: min(signInFailures.failedAt) })
		.from(signInFailures)
		.where(
			and(
				eq(signInFailures.address, attempt.address),
				gt(signInFailures.failedAt, new Date(now - ADDRESS_LIMIT.windowMs))
			)
		)
		.get();
	if (
		byAddress !== undefined &&
		byAddress.total >= ADDRESS_LIMIT.failures &&
		byAddress.oldest !== null
	) {
		return {
			kind: 'paused',
			untilMs: byAddress.oldest.getTime() + ADDRESS_LIMIT.windowMs,
			by: 'address'
		};
	}
	return { kind: 'none' };
}

export function recordSignInFailure(
	database: Queryable,
	attempt: { email: string; address: string },
	now: number
): void {
	database
		.delete(signInFailures)
		.where(lt(signInFailures.failedAt, new Date(now - KEEP_MS)))
		.run();
	database
		.insert(signInFailures)
		.values({
			id: crypto.randomUUID(),
			email: attempt.email,
			address: attempt.address,
			failedAt: new Date(now)
		})
		.run();
}

/** A successful sign-in clears that email's failures. */
export function clearSignInFailures(database: Queryable, email: string): void {
	database.delete(signInFailures).where(eq(signInFailures.email, email)).run();
}
