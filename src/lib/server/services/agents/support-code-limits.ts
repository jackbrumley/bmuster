import { and, count, eq, gt, lt, max, min } from 'drizzle-orm';
import { supportCodeFailures } from '../../database/schema.ts';
import type { Queryable } from '../../database/connection.ts';

/**
 * Guessing limits for support codes on /join (SPEC-JOIN 5), in the pattern of
 * the sign-in limits: failures in a table, counted over a window.
 * - Per address, within 30 minutes: 3 wrong codes are free; after the nth
 *   (n ≥ 3) the next try waits 5 × (n − 2) seconds; from the 10th on, each
 *   pauses the address for 15 minutes. The window is longer than the pause,
 *   so the pause is not cut short by older failures leaving the count.
 * - The whole server, within 15 minutes: 30 wrong codes pause every address
 *   until the oldest of them is 15 minutes old.
 * A paused attempt is refused before the code is looked at, and not counted.
 */
export const ADDRESS_LIMIT = {
	windowMs: 30 * 60_000,
	freeFailures: 3,
	stepMs: 5_000,
	pauseAfter: 10,
	pauseMs: 15 * 60_000
} as const;
export const SERVER_LIMIT = { failures: 30, windowMs: 15 * 60_000 } as const;

/** Failures older than this are deleted. */
const KEEP_MS = 24 * 60 * 60_000;

export type SupportCodePause =
	| { kind: 'none' }
	/** `slow`: wait a little; `address`: this address is paused; `server`: everyone is. */
	| { kind: 'paused'; untilMs: number; by: 'slow' | 'address' | 'server' };

export function supportCodePause(
	database: Queryable,
	address: string,
	now: number
): SupportCodePause {
	const everyone = database
		.select({ total: count(), oldest: min(supportCodeFailures.failedAt) })
		.from(supportCodeFailures)
		.where(gt(supportCodeFailures.failedAt, new Date(now - SERVER_LIMIT.windowMs)))
		.get();
	if (
		everyone !== undefined &&
		everyone.total >= SERVER_LIMIT.failures &&
		everyone.oldest !== null
	) {
		return {
			kind: 'paused',
			untilMs: everyone.oldest.getTime() + SERVER_LIMIT.windowMs,
			by: 'server'
		};
	}
	const mine = database
		.select({ total: count(), latest: max(supportCodeFailures.failedAt) })
		.from(supportCodeFailures)
		.where(
			and(
				eq(supportCodeFailures.address, address),
				gt(supportCodeFailures.failedAt, new Date(now - ADDRESS_LIMIT.windowMs))
			)
		)
		.get();
	if (mine === undefined || mine.latest === null || mine.total < ADDRESS_LIMIT.freeFailures) {
		return { kind: 'none' };
	}
	const latest = mine.latest.getTime();
	const untilMs =
		mine.total >= ADDRESS_LIMIT.pauseAfter
			? latest + ADDRESS_LIMIT.pauseMs
			: latest + ADDRESS_LIMIT.stepMs * (mine.total - ADDRESS_LIMIT.freeFailures + 1);
	if (untilMs <= now) {
		return { kind: 'none' };
	}
	return {
		kind: 'paused',
		untilMs,
		by: mine.total >= ADDRESS_LIMIT.pauseAfter ? 'address' : 'slow'
	};
}

export function recordSupportCodeFailure(database: Queryable, address: string, now: number): void {
	database
		.delete(supportCodeFailures)
		.where(lt(supportCodeFailures.failedAt, new Date(now - KEEP_MS)))
		.run();
	database
		.insert(supportCodeFailures)
		.values({ id: crypto.randomUUID(), address, failedAt: new Date(now) })
		.run();
}
