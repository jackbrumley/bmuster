import { desc, eq } from 'drizzle-orm';
import { groupCode, normaliseCode, randomCode } from '../../crypto/random-code.ts';
import { joinCodes, machines } from '../../database/schema.ts';
import type { AppDatabase, Queryable } from '../../database/connection.ts';
import { sha256Hex } from './signing.ts';
import { refuse, type AgentRefusal } from './agent-refusal.ts';

const JOIN_CODE_LIMITS = { maxUses: 100, maxMinutes: 7 * 24 * 60 } as const;

export type NewJoinCode = { id: string; code: string; expiresAt: Date; maxUses: number };

/** What has happened to a join code since it was made (Add machine shows it live). */
export type JoinCodeStatus = {
	maxUses: number;
	uses: number;
	expiresAt: Date;
	/** `open` until every use is taken (`used-up`) or the time runs out (`expired`); used-up wins. */
	state: 'open' | 'used-up' | 'expired';
	/** Machines enrolled with the code, newest first, removed ones included and marked. */
	machines: { id: string; name: string; enrolledAt: Date; removed: boolean }[];
};

/** Makes a join code (SPEC-ENROLMENT 5). The code itself is returned once and never stored. */
export function createJoinCode(
	database: Queryable,
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
	return insertCode(database, { ...options, reinstallMachineId: null }, now);
}

/**
 * Makes a reinstall code for one machine (SPEC-MACHINE-DETAILS D9): single
 * use, 60 minutes. Enrolling with it takes over that machine's entry.
 * Undefined when the machine is unknown or removed.
 */
export function createReinstallCode(
	database: AppDatabase,
	machineId: string,
	createdBy: string,
	now: number
): NewJoinCode | undefined {
	return database.transaction((tx) => {
		const machine = tx
			.select({ removedAt: machines.removedAt })
			.from(machines)
			.where(eq(machines.id, machineId))
			.get();
		if (machine?.removedAt !== null) {
			return undefined;
		}
		return insertCode(
			tx,
			{ maxUses: 1, minutes: 60, machineGroupIds: [], createdBy, reinstallMachineId: machineId },
			now
		);
	});
}

function insertCode(
	database: Queryable,
	options: {
		maxUses: number;
		minutes: number;
		machineGroupIds: string[];
		createdBy: string | null;
		reinstallMachineId: string | null;
	},
	now: number
): NewJoinCode {
	const raw = randomCode(9);
	const id = crypto.randomUUID();
	const expiresAt = new Date(now + options.minutes * 60_000);
	database
		.insert(joinCodes)
		.values({
			id,
			codeHash: hashCode(raw),
			machineGroupIds: JSON.stringify(options.machineGroupIds),
			maxUses: options.maxUses,
			uses: 0,
			createdBy: options.createdBy,
			createdAt: new Date(now),
			expiresAt,
			reinstallMachineId: options.reinstallMachineId
		})
		.run();
	return {
		id,
		code: groupCode(raw, 3),
		expiresAt,
		maxUses: options.maxUses
	};
}

/** What a redeemed code allows: a new machine, or taking over an existing one's entry (D9). */
export type RedeemedCode = {
	joinCodeId: string;
	maxUses: number;
	machineGroupIds: string[];
	purpose: { kind: 'new-machine' } | { kind: 'reinstall'; machineId: string };
};

/** Uses one use of a code. Call inside the enrolment transaction. */
export function redeemJoinCode(
	database: Queryable,
	typed: string,
	now: number
): RedeemedCode | AgentRefusal {
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
	if (row.reinstallMachineId !== null) {
		const target = database
			.select({ removedAt: machines.removedAt })
			.from(machines)
			.where(eq(machines.id, row.reinstallMachineId))
			.get();
		if (target?.removedAt !== null) {
			return refuse(
				'invalid-code',
				'The machine this reinstall code was made for has been removed from the server. Add it again with a new join code.'
			);
		}
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
	return {
		joinCodeId: row.id,
		maxUses: row.maxUses,
		machineGroupIds: groups,
		purpose:
			row.reinstallMachineId === null
				? { kind: 'new-machine' }
				: { kind: 'reinstall', machineId: row.reinstallMachineId }
	};
}

/** A join code's uses and the machines that joined with it; undefined for an unknown id. */
export function joinCodeStatus(
	database: Queryable,
	id: string,
	now: number
): JoinCodeStatus | undefined {
	const row = database.select().from(joinCodes).where(eq(joinCodes.id, id)).get();
	if (row === undefined) {
		return undefined;
	}
	const joined = database
		.select({
			id: machines.id,
			name: machines.name,
			enrolledAt: machines.enrolledAt,
			removedAt: machines.removedAt
		})
		.from(machines)
		.where(eq(machines.joinCodeId, id))
		.orderBy(desc(machines.enrolledAt))
		.all();
	return {
		maxUses: row.maxUses,
		uses: row.uses,
		expiresAt: row.expiresAt,
		state: codeState(row.uses, row.maxUses, row.expiresAt, now),
		machines: joined.map((machine) => ({
			id: machine.id,
			name: machine.name,
			enrolledAt: machine.enrolledAt,
			removed: machine.removedAt !== null
		}))
	};
}

function codeState(
	uses: number,
	maxUses: number,
	expiresAt: Date,
	now: number
): JoinCodeStatus['state'] {
	if (uses >= maxUses) {
		return 'used-up';
	}
	return expiresAt.getTime() <= now ? 'expired' : 'open';
}

function hashCode(raw: string): string {
	return sha256Hex(Buffer.from(raw, 'utf8'));
}
