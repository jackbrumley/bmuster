import { eq } from 'drizzle-orm';
import { groupCode, normaliseCode, randomCode } from '../../crypto/random-code.ts';
import { joinCodes } from '../../database/schema.ts';
import type { AppDatabase, Queryable } from '../../database/connection.ts';
import { sha256Hex } from './signing.ts';
import { refuse, type AgentRefusal } from './agent-refusal.ts';

const JOIN_CODE_LIMITS = { maxUses: 100, maxMinutes: 7 * 24 * 60 } as const;

export type NewJoinCode = { code: string; expiresAt: Date; maxUses: number };

/** Makes a join code (SPEC-ENROLMENT 5). The code itself is returned once and never stored. */
export function createJoinCode(
	database: AppDatabase,
	options: {
		maxUses: number;
		minutes: number;
		machineGroupIds: string[];
		/** The admin who made it; null only for codes made outside the console (tests, scripts). */
		createdBy: string | null;
	},
	now: number
): NewJoinCode {
	if (options.maxUses < 1 || options.maxUses > JOIN_CODE_LIMITS.maxUses) {
		throw new Error(`A join code allows 1 to ${JOIN_CODE_LIMITS.maxUses} uses`);
	}
	if (options.minutes < 1 || options.minutes > JOIN_CODE_LIMITS.maxMinutes) {
		throw new Error('A join code lasts between 1 minute and 7 days');
	}
	const raw = randomCode(9);
	const expiresAt = new Date(now + options.minutes * 60_000);
	database
		.insert(joinCodes)
		.values({
			id: crypto.randomUUID(),
			codeHash: hashCode(raw),
			machineGroupIds: JSON.stringify(options.machineGroupIds),
			maxUses: options.maxUses,
			uses: 0,
			createdBy: options.createdBy,
			createdAt: new Date(now),
			expiresAt
		})
		.run();
	return {
		code: groupCode(raw, 3),
		expiresAt,
		maxUses: options.maxUses
	};
}

/** Uses one use of a code. Call inside the enrolment transaction. */
export function redeemJoinCode(
	database: Queryable,
	typed: string,
	now: number
): { machineGroupIds: string[] } | AgentRefusal {
	const row = database
		.select()
		.from(joinCodes)
		.where(eq(joinCodes.codeHash, hashCode(normaliseCode(typed))))
		.get();
	if (row === undefined) {
		return refuse('invalid-code', 'That join code is not known to this server.');
	}
	if (row.expiresAt.getTime() <= now) {
		return refuse('expired-code', 'That join code has expired. Make a new one in the console.');
	}
	if (row.uses >= row.maxUses) {
		return refuse('used-code', 'That join code has already been used.');
	}
	database
		.update(joinCodes)
		.set({ uses: row.uses + 1 })
		.where(eq(joinCodes.id, row.id))
		.run();
	const groups: unknown = JSON.parse(row.machineGroupIds);
	if (!Array.isArray(groups) || !groups.every((group) => typeof group === 'string')) {
		throw new Error(`Join code ${row.id} has malformed machine group ids`);
	}
	return { machineGroupIds: groups };
}

function hashCode(raw: string): string {
	return sha256Hex(Buffer.from(raw, 'utf8'));
}
