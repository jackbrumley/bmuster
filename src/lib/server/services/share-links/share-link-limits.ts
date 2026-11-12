import { and, count, eq, gt, lt, min } from 'drizzle-orm';
import { shareLinkFailures } from '../../database/schema.ts';
import type { Queryable } from '../../database/connection.ts';

/**
 * The rate limit on share-link lookups (SPEC-SHARE-LINKS D5), in the pattern
 * of the sign-in limits: failures (a wrong, ended or malformed token, a
 * missing or wrong guest cookie) in a table, counted per address. 10 within
 * 15 minutes pause the address until the oldest of them is 15 minutes old. A
 * paused request is refused before the token is looked at, and not counted.
 * No server-wide pause: it would let one address lock real guests out.
 */
export const SHARE_LINK_LIMIT = { failures: 10, windowMs: 15 * 60_000 } as const;

/** Failures older than this are deleted. */
const KEEP_MS = 24 * 60 * 60_000;

export type ShareLinkPause = { kind: 'none' } | { kind: 'paused'; untilMs: number };

export function shareLinkPause(database: Queryable, address: string, now: number): ShareLinkPause {
	const mine = database
		.select({ total: count(), oldest: min(shareLinkFailures.failedAt) })
		.from(shareLinkFailures)
		.where(
			and(
				eq(shareLinkFailures.address, address),
				gt(shareLinkFailures.failedAt, new Date(now - SHARE_LINK_LIMIT.windowMs))
			)
		)
		.get();
	if (mine === undefined || mine.oldest === null || mine.total < SHARE_LINK_LIMIT.failures) {
		return { kind: 'none' };
	}
	return { kind: 'paused', untilMs: mine.oldest.getTime() + SHARE_LINK_LIMIT.windowMs };
}

export function recordShareLinkFailure(database: Queryable, address: string, now: number): void {
	database
		.delete(shareLinkFailures)
		.where(lt(shareLinkFailures.failedAt, new Date(now - KEEP_MS)))
		.run();
	database
		.insert(shareLinkFailures)
		.values({ id: crypto.randomUUID(), address, failedAt: new Date(now) })
		.run();
}

/** What a paused address is told: plain, and the same whatever it was trying. */
export const PAUSED_MESSAGE = 'Too many tries from this address. Try again in 15 minutes.';
