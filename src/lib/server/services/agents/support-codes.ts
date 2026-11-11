import { createHmac, randomInt } from 'node:crypto';
import { and, desc, eq, gt } from 'drizzle-orm';
import {
	SCAM_QUESTIONS,
	SUPPORT_CODE_MINUTES,
	supportCodeDigits,
	type ScamQuestionId
} from '#lib/domain/machines/phone-support.ts';
import { openSecret, sealSecret } from '../../crypto/secret-box.ts';
import { supportCodes } from '../../database/schema.ts';
import type { AppDatabase, Queryable } from '../../database/connection.ts';
import { recordAudit } from '../audit/audit.ts';
import { getSetting, organisationName } from '../settings/settings.ts';
import { userNames } from '../users/users.ts';
import { createJoinCode, expireJoinCode, joinCodeUses } from './join-codes.ts';
import {
	recordSupportCodeFailure,
	supportCodePause,
	type SupportCodePause
} from './support-code-limits.ts';

/**
 * Enrolment codes (SPEC-JOIN): six digits standing for one single-use
 * join code. An admin makes one on Add machine; the person at the computer
 * types it on the public /join page. Every lookup from /join goes through the guessing
 * limits, and every refusal looks the same.
 */

/** After its join code is used, a code still answers "connected" this long after it was made. */
const CONNECTED_FOR_MS = 60 * 60_000;

/** A code is never reissued while an earlier one with the same digits could still be looked up. */
const REUSE_AFTER_MS = CONNECTED_FOR_MS;

export type NewSupportCode = { id: string; code: string; expiresAt: Date; joinCodeId: string };

/** J1: a support code and its single-use join code, both 15 minutes, carrying the chosen groups. */
export function createSupportCode(
	database: AppDatabase,
	key: Buffer,
	options: { machineGroupIds: string[]; createdBy: string },
	now: number
): NewSupportCode {
	return database.transaction((tx) => {
		const code = freshDigits(tx, key, now);
		const joinCode = createJoinCode(
			tx,
			{
				maxUses: 1,
				minutes: SUPPORT_CODE_MINUTES,
				machineGroupIds: options.machineGroupIds,
				createdBy: options.createdBy
			},
			now
		);
		const id = crypto.randomUUID();
		tx.insert(supportCodes)
			.values({
				id,
				codeHash: hashDigits(key, code),
				joinCodeId: joinCode.id,
				joinCodeSealed: sealSecret(Buffer.from(joinCode.code, 'utf8'), key),
				createdBy: options.createdBy,
				createdAt: new Date(now),
				expiresAt: joinCode.expiresAt,
				cancelledAt: null,
				enteredAt: null
			})
			.run();
		recordAudit(
			tx,
			{
				actor: { kind: 'user', userId: options.createdBy },
				kind: 'support-code-started',
				target: 'Enrolment code',
				machineId: null,
				detail: {
					expires: joinCode.expiresAt.toISOString(),
					'machine groups': String(options.machineGroupIds.length)
				}
			},
			now
		);
		return { id, code, expiresAt: joinCode.expiresAt, joinCodeId: joinCode.id };
	});
}

/** J3: ends an open code and its join code at once. */
export function cancelSupportCode(
	database: AppDatabase,
	id: string,
	actorUserId: string,
	now: number
): 'cancelled' | 'not-found' | 'not-open' {
	return database.transaction((tx) => {
		const row = tx.select().from(supportCodes).where(eq(supportCodes.id, id)).get();
		if (row === undefined) {
			return 'not-found';
		}
		if (stateOf(tx, row, now) !== 'open') {
			return 'not-open';
		}
		tx.update(supportCodes)
			.set({ cancelledAt: new Date(now), joinCodeSealed: null })
			.where(eq(supportCodes.id, id))
			.run();
		expireJoinCode(tx, row.joinCodeId, now);
		recordAudit(
			tx,
			{
				actor: { kind: 'user', userId: actorUserId },
				kind: 'support-code-cancelled',
				target: 'Enrolment code',
				machineId: null,
				detail: {}
			},
			now
		);
		return 'cancelled';
	});
}

/** Who is asking on /join: their address (for the limits) and the code they typed. */
export type JoinAttempt = { typed: string; address: string };

/** Every refusal on /join: a wrong code of any kind, or a pause from the limits (J4, J5). */
export type JoinRefusal =
	| { kind: 'wrong' }
	| { kind: 'paused'; untilMs: number; by: Exclude<SupportCodePause, { kind: 'none' }>['by'] };

export type JoinCheck =
	| {
			kind: 'open';
			supportPerson: string;
			organisation: string;
			expiresAt: Date;
			scamWording: { impersonators: string; reportAdvice: string };
	  }
	| { kind: 'connected'; supportPerson: string };

/**
 * J2, J6: what /join shows for a typed code. The first time an open code is
 * entered is audited. `hostname` is the server's name as the caller reached
 * it, for a blank organisation name.
 */
export function checkSupportCode(
	database: AppDatabase,
	key: Buffer,
	attempt: JoinAttempt,
	hostname: string,
	now: number
): JoinCheck | JoinRefusal {
	return database.transaction((tx) => {
		const found = findLive(tx, key, attempt, ['open', 'connected'], now);
		if (found.kind !== 'found') {
			return found;
		}
		const { row, state } = found;
		const supportPerson = personName(tx, row.createdBy);
		if (state === 'connected') {
			return { kind: 'connected', supportPerson };
		}
		if (row.enteredAt === null) {
			tx.update(supportCodes)
				.set({ enteredAt: new Date(now) })
				.where(eq(supportCodes.id, row.id))
				.run();
			recordAudit(
				tx,
				{
					actor: { kind: 'system' },
					kind: 'support-code-entered',
					target: `Enrolment code from ${supportPerson}`,
					machineId: null,
					detail: { address: attempt.address }
				},
				now
			);
		}
		return {
			kind: 'open',
			supportPerson,
			organisation: organisationName(tx, hostname),
			expiresAt: row.expiresAt,
			scamWording: {
				impersonators: getSetting(tx, 'scamImpersonators'),
				reportAdvice: getSetting(tx, 'scamReportAdvice')
			}
		};
	});
}

/** J8: an unsafe answer in the scam check, recorded in Activity. The code stays valid. */
export function recordScamStop(
	database: AppDatabase,
	key: Buffer,
	attempt: JoinAttempt,
	question: ScamQuestionId,
	now: number
): { kind: 'recorded' } | JoinRefusal {
	return database.transaction((tx) => {
		const found = findLive(tx, key, attempt, ['open'], now);
		if (found.kind !== 'found') {
			return found;
		}
		const asked = SCAM_QUESTIONS.find((candidate) => candidate.id === question);
		recordAudit(
			tx,
			{
				actor: { kind: 'system' },
				kind: 'support-code-scam-stop',
				target: `Enrolment code from ${personName(tx, found.row.createdBy)}`,
				machineId: null,
				detail: { question: asked === undefined ? question : asked.text, address: attempt.address }
			},
			now
		);
		return { kind: 'recorded' };
	});
}

/** J7: the join code behind an open support code, for the install command. */
export function supportJoinCode(
	database: AppDatabase,
	key: Buffer,
	attempt: JoinAttempt,
	now: number
): { kind: 'open'; joinCode: string } | JoinRefusal {
	return database.transaction((tx) => {
		const found = findLive(tx, key, attempt, ['open'], now);
		if (found.kind !== 'found') {
			return found;
		}
		if (found.row.joinCodeSealed === null) {
			throw new Error(`Support code ${found.row.id} is open but has no join code`);
		}
		return {
			kind: 'open',
			joinCode: openSecret(found.row.joinCodeSealed, key).toString('utf8')
		};
	});
}

type SupportCodeRow = typeof supportCodes.$inferSelect;
type CodeState = 'open' | 'connected' | 'gone';

/**
 * The limits first (a paused attempt is not looked at), then the code. A code
 * that is not in one of `wanted` states counts as a wrong one.
 */
function findLive(
	tx: Queryable,
	key: Buffer,
	attempt: JoinAttempt,
	wanted: readonly CodeState[],
	now: number
): { kind: 'found'; row: SupportCodeRow; state: CodeState } | JoinRefusal {
	const pause = supportCodePause(tx, attempt.address, now);
	if (pause.kind === 'paused') {
		return pause;
	}
	const digits = supportCodeDigits(attempt.typed);
	const row =
		digits === undefined
			? undefined
			: tx
					.select()
					.from(supportCodes)
					.where(
						and(
							eq(supportCodes.codeHash, hashDigits(key, digits)),
							gt(supportCodes.createdAt, new Date(now - REUSE_AFTER_MS))
						)
					)
					.orderBy(desc(supportCodes.createdAt))
					.get();
	const state = row === undefined ? 'gone' : stateOf(tx, row, now);
	if (row === undefined || !wanted.includes(state)) {
		recordSupportCodeFailure(tx, attempt.address, now);
		return { kind: 'wrong' };
	}
	return { kind: 'found', row, state };
}

function stateOf(tx: Queryable, row: SupportCodeRow, now: number): CodeState {
	if (row.cancelledAt !== null) {
		return 'gone';
	}
	const uses = joinCodeUses(tx, row.joinCodeId);
	if (uses === undefined) {
		throw new Error(`Support code ${row.id} points at a missing join code`);
	}
	if (uses > 0) {
		return row.createdAt.getTime() + CONNECTED_FOR_MS > now ? 'connected' : 'gone';
	}
	return row.expiresAt.getTime() > now ? 'open' : 'gone';
}

/** Six random digits not used by any code that could still be looked up. */
function freshDigits(tx: Queryable, key: Buffer, now: number): string {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		const digits = String(randomInt(1_000_000)).padStart(6, '0');
		const taken = tx
			.select({ id: supportCodes.id })
			.from(supportCodes)
			.where(
				and(
					eq(supportCodes.codeHash, hashDigits(key, digits)),
					gt(supportCodes.createdAt, new Date(now - REUSE_AFTER_MS))
				)
			)
			.get();
		if (taken === undefined) {
			return digits;
		}
	}
	throw new Error('Could not find a free support code after 20 tries');
}

function hashDigits(key: Buffer, digits: string): string {
	return createHmac('sha256', key).update(`support-code:${digits}`).digest('hex');
}

function personName(tx: Queryable, userId: string): string {
	const name = userNames(tx, [userId]).get(userId);
	if (name === undefined) {
		throw new Error(`Support code maker ${userId} is not a user`);
	}
	return name;
}
