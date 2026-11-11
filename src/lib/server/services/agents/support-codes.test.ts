import { describe, expect, it } from 'vitest';
import type { AppDatabase } from '#lib/server/database/connection.ts';
import { done } from '#tests/helpers/access.ts';
import { enrolWithCode, testDatabase } from '#tests/helpers/fake-agent.ts';
import { addTestUser, NOW } from '#tests/helpers/people.ts';
import { createGroup } from '../access/groups.ts';
import { listAudit } from '../audit/audit.ts';
import { updateSetting } from '../settings/settings.ts';
import { isRefusal } from './agent-refusal.ts';
import { joinCodeStatus } from './join-codes.ts';
import { SERVER_LIMIT } from './support-code-limits.ts';
import {
	cancelSupportCode,
	checkSupportCode,
	createSupportCode,
	recordScamStop,
	supportJoinCode,
	type JoinAttempt
} from './support-codes.ts';

const KEY = Buffer.alloc(32, 9);
const HOST = 'bmuster.example.com';
const MINUTE = 60_000;

async function setUp(): Promise<{ database: AppDatabase; adminId: string }> {
	const database = testDatabase();
	const admin = await addTestUser(database, {
		email: 'ada@example.com',
		role: 'admin',
		password: null
	});
	return { database, adminId: admin.id };
}

function caller(typed: string, address = '198.51.100.7'): JoinAttempt {
	return { typed, address };
}

/** A code that is not `code`, so it is certainly wrong. */
function otherCode(code: string): string {
	return code === '000000' ? '000001' : '000000';
}

describe('support codes: start (J1)', () => {
	it('makes six digits backed by a single-use 15-minute join code with the chosen groups, audited', async () => {
		const { database, adminId } = await setUp();
		const group = done(
			createGroup(database, 'machine', adminId, { name: 'Front desk', description: '' }, NOW)
		);
		const created = createSupportCode(
			database,
			KEY,
			{ machineGroupIds: [group], createdBy: adminId },
			NOW
		);
		expect(created.code).toMatch(/^\d{6}$/);
		expect(created.expiresAt.getTime()).toBe(NOW + 15 * MINUTE);
		expect(joinCodeStatus(database, created.joinCodeId, NOW)).toMatchObject({
			maxUses: 1,
			uses: 0,
			state: 'open',
			expiresAt: created.expiresAt
		});
		const joinCode = supportJoinCode(database, KEY, caller(created.code), NOW);
		if (joinCode.kind !== 'open') {
			throw new Error('expected the join code');
		}
		const joined = enrolWithCode(database, joinCode.joinCode, 'DESKTOP-ABC', NOW + MINUTE);
		expect(isRefusal(joined)).toBe(false);
		const audit = listAudit(database, 10);
		expect(audit).toContainEqual(
			expect.objectContaining({
				kind: 'support-code-started',
				actorUserId: adminId,
				target: 'Enrolment code'
			})
		);
		// No support code ever lands in Activity.
		expect(JSON.stringify(audit)).not.toContain(created.code);
	});

	it('never reissues digits that could still be looked up', async () => {
		const { database, adminId } = await setUp();
		const codes = new Set<string>();
		for (let index = 0; index < 50; index += 1) {
			codes.add(
				createSupportCode(database, KEY, { machineGroupIds: [], createdBy: adminId }, NOW).code
			);
		}
		expect(codes.size).toBe(50);
	});
});

describe('support codes: checking on /join (J2, J6)', () => {
	it('names the support person and the organisation, and audits the first entry only', async () => {
		const { database, adminId } = await setUp();
		const { code } = createSupportCode(
			database,
			KEY,
			{ machineGroupIds: [], createdBy: adminId },
			NOW
		);
		const typedWithSpace = `${code.slice(0, 3)} ${code.slice(3)}`;
		expect(checkSupportCode(database, KEY, caller(typedWithSpace), HOST, NOW)).toMatchObject({
			kind: 'open',
			supportPerson: 'ada',
			organisation: HOST,
			expiresAt: new Date(NOW + 15 * MINUTE),
			scamWording: {
				impersonators: 'Microsoft, your bank, the police, the NBN or a computer company'
			}
		});
		updateSetting(database, adminId, 'organisationName', 'Example IT', NOW);
		expect(checkSupportCode(database, KEY, caller(code), HOST, NOW + MINUTE)).toMatchObject({
			kind: 'open',
			organisation: 'Example IT'
		});
		const entered = listAudit(database, 20).filter(
			(entry) => entry.kind === 'support-code-entered'
		);
		expect(entered).toEqual([
			expect.objectContaining({
				actorUserId: null,
				target: 'Enrolment code from ada',
				detail: { address: '198.51.100.7' }
			})
		]);
	});

	it('works until it expires', async () => {
		const { database, adminId } = await setUp();
		const { code } = createSupportCode(
			database,
			KEY,
			{ machineGroupIds: [], createdBy: adminId },
			NOW
		);
		expect(checkSupportCode(database, KEY, caller(code), HOST, NOW + 15 * MINUTE - 1).kind).toBe(
			'open'
		);
		expect(checkSupportCode(database, KEY, caller(code), HOST, NOW + 15 * MINUTE)).toEqual({
			kind: 'wrong'
		});
		expect(supportJoinCode(database, KEY, caller(code), NOW + 15 * MINUTE)).toEqual({
			kind: 'wrong'
		});
	});

	it('is single use: once its machine joins it reports connected and gives out no command', async () => {
		const { database, adminId } = await setUp();
		const { code } = createSupportCode(
			database,
			KEY,
			{ machineGroupIds: [], createdBy: adminId },
			NOW
		);
		const joinCode = supportJoinCode(database, KEY, caller(code), NOW);
		if (joinCode.kind !== 'open') {
			throw new Error('expected the join code');
		}
		expect(isRefusal(enrolWithCode(database, joinCode.joinCode, 'one', NOW))).toBe(false);
		expect(enrolWithCode(database, joinCode.joinCode, 'two', NOW)).toMatchObject({
			reason: 'used-code'
		});
		expect(checkSupportCode(database, KEY, caller(code), HOST, NOW + 20 * MINUTE)).toEqual({
			kind: 'connected',
			supportPerson: 'ada'
		});
		expect(supportJoinCode(database, KEY, caller(code), NOW)).toEqual({ kind: 'wrong' });
		expect(recordScamStop(database, KEY, caller(code), 'virus', NOW)).toEqual({ kind: 'wrong' });
		// Connected is only reported for an hour after the code was made.
		expect(checkSupportCode(database, KEY, caller(code), HOST, NOW + 60 * MINUTE)).toEqual({
			kind: 'wrong'
		});
	});

	it('refuses anything that is not a live code the same way', async () => {
		const { database, adminId } = await setUp();
		const { code } = createSupportCode(
			database,
			KEY,
			{ machineGroupIds: [], createdBy: adminId },
			NOW
		);
		for (const typed of [otherCode(code), '12345', 'abcdef', '', `${code}0`]) {
			expect(
				checkSupportCode(database, KEY, caller(typed, `203.0.113.${typed.length}`), HOST, NOW)
			).toEqual({
				kind: 'wrong'
			});
		}
	});
});

describe('support codes: cancel (J3)', () => {
	it('stops the code and its join code at once, audited', async () => {
		const { database, adminId } = await setUp();
		const created = createSupportCode(
			database,
			KEY,
			{ machineGroupIds: [], createdBy: adminId },
			NOW
		);
		const joinCode = supportJoinCode(database, KEY, caller(created.code), NOW);
		if (joinCode.kind !== 'open') {
			throw new Error('expected the join code');
		}
		expect(cancelSupportCode(database, created.id, adminId, NOW + MINUTE)).toBe('cancelled');
		expect(checkSupportCode(database, KEY, caller(created.code), HOST, NOW + MINUTE)).toEqual({
			kind: 'wrong'
		});
		expect(enrolWithCode(database, joinCode.joinCode, 'late', NOW + MINUTE)).toMatchObject({
			reason: 'expired-code'
		});
		expect(joinCodeStatus(database, created.joinCodeId, NOW + MINUTE)?.state).toBe('expired');
		expect(cancelSupportCode(database, created.id, adminId, NOW + MINUTE)).toBe('not-open');
		expect(cancelSupportCode(database, crypto.randomUUID(), adminId, NOW)).toBe('not-found');
		expect(listAudit(database, 1)).toEqual([
			expect.objectContaining({ kind: 'support-code-cancelled', actorUserId: adminId })
		]);
	});

	it('cannot cancel a code whose machine has joined', async () => {
		const { database, adminId } = await setUp();
		const created = createSupportCode(
			database,
			KEY,
			{ machineGroupIds: [], createdBy: adminId },
			NOW
		);
		const joinCode = supportJoinCode(database, KEY, caller(created.code), NOW);
		if (joinCode.kind !== 'open') {
			throw new Error('expected the join code');
		}
		enrolWithCode(database, joinCode.joinCode, 'joined', NOW);
		expect(cancelSupportCode(database, created.id, adminId, NOW)).toBe('not-open');
	});
});

describe('support codes: the scam check stop (J8)', () => {
	it('is recorded in Activity with the question, and the code stays valid', async () => {
		const { database, adminId } = await setUp();
		const { code } = createSupportCode(
			database,
			KEY,
			{ machineGroupIds: [], createdBy: adminId },
			NOW
		);
		expect(recordScamStop(database, KEY, caller(code), 'money', NOW)).toEqual({
			kind: 'recorded'
		});
		expect(listAudit(database, 1)).toEqual([
			expect.objectContaining({
				kind: 'support-code-scam-stop',
				actorUserId: null,
				target: 'Enrolment code from ada',
				detail: {
					question: 'Has anyone asked you to log in to your bank, buy gift cards, or send money?',
					address: '198.51.100.7'
				}
			})
		]);
		expect(supportJoinCode(database, KEY, caller(code), NOW).kind).toBe('open');
	});

	it('is not recorded for a wrong code', async () => {
		const { database, adminId } = await setUp();
		const { code } = createSupportCode(
			database,
			KEY,
			{ machineGroupIds: [], createdBy: adminId },
			NOW
		);
		expect(recordScamStop(database, KEY, caller(otherCode(code)), 'virus', NOW)).toEqual({
			kind: 'wrong'
		});
		expect(listAudit(database, 5).some((entry) => entry.kind === 'support-code-scam-stop')).toBe(
			false
		);
	});
});

describe('support codes: guessing limits (J4)', () => {
	it('slows an address down after 3 wrong codes, then pauses it, even for the right code', async () => {
		const { database, adminId } = await setUp();
		const { code } = createSupportCode(
			database,
			KEY,
			{ machineGroupIds: [], createdBy: adminId },
			NOW
		);
		const wrong = otherCode(code);
		let now = NOW;
		for (let index = 0; index < 3; index += 1) {
			expect(checkSupportCode(database, KEY, caller(wrong), HOST, now)).toEqual({ kind: 'wrong' });
		}
		expect(checkSupportCode(database, KEY, caller(code), HOST, now)).toEqual({
			kind: 'paused',
			untilMs: now + 5_000,
			by: 'slow'
		});
		// Another address is not slowed.
		expect(checkSupportCode(database, KEY, caller(code, '192.0.2.99'), HOST, now).kind).toBe(
			'open'
		);
		for (let index = 3; index < 10; index += 1) {
			now += 60_000;
			expect(checkSupportCode(database, KEY, caller(wrong), HOST, now)).toEqual({ kind: 'wrong' });
		}
		expect(checkSupportCode(database, KEY, caller(code), HOST, now + 14 * MINUTE)).toMatchObject({
			kind: 'paused',
			by: 'address'
		});
	});

	it('pauses every address when the whole server sees too many wrong codes', async () => {
		const { database, adminId } = await setUp();
		const later = NOW + 10 * MINUTE;
		const { code } = createSupportCode(
			database,
			KEY,
			{ machineGroupIds: [], createdBy: adminId },
			later
		);
		for (let index = 0; index < SERVER_LIMIT.failures; index += 1) {
			const address = `10.0.${String(index)}.1`;
			expect(checkSupportCode(database, KEY, caller(otherCode(code), address), HOST, NOW)).toEqual({
				kind: 'wrong'
			});
		}
		const fresh = caller(code, '192.0.2.200');
		expect(checkSupportCode(database, KEY, fresh, HOST, later)).toEqual({
			kind: 'paused',
			untilMs: NOW + SERVER_LIMIT.windowMs,
			by: 'server'
		});
		expect(supportJoinCode(database, KEY, fresh, later).kind).toBe('paused');
		expect(checkSupportCode(database, KEY, fresh, HOST, NOW + SERVER_LIMIT.windowMs).kind).toBe(
			'open'
		);
	});

	it('does not count polling with the right code', async () => {
		const { database, adminId } = await setUp();
		const { code } = createSupportCode(
			database,
			KEY,
			{ machineGroupIds: [], createdBy: adminId },
			NOW
		);
		for (let index = 0; index < 100; index += 1) {
			expect(checkSupportCode(database, KEY, caller(code), HOST, NOW + index * 3_000).kind).toBe(
				'open'
			);
		}
	});
});
