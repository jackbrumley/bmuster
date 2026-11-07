import { describe, expect, it } from 'vitest';
import type { AppDatabase } from '#lib/server/database/connection.ts';
import { createJoinCodeRequestSchema } from '#lib/schemas/machines/join-codes.ts';
import { done } from '#tests/helpers/access.ts';
import { enrolWithCode, SERVER_PUBLIC_KEY, testDatabase } from '#tests/helpers/fake-agent.ts';
import { addTestUser } from '#tests/helpers/people.ts';
import {
	areChosenMachineGroups,
	createGroup,
	deleteGroup,
	listMachineGroups
} from '../access/groups.ts';
import { listAudit } from '../audit/audit.ts';
import { removeMachine } from '../machines/machine-views.ts';
import { enrolMachine } from './enrolment.ts';
import { isRefusal } from './agent-refusal.ts';
import { createJoinCode, joinCodeStatus, redeemJoinCode } from './join-codes.ts';

const NOW = 1_794_000_000_000;

describe('join codes (A1, A2)', () => {
	it('makes a readable code that works once, typed in any case with or without hyphens', () => {
		const database = testDatabase();
		const { id, code, expiresAt } = createJoinCode(
			database,
			{ maxUses: 1, minutes: 60, machineGroupIds: ['g1'], createdBy: null },
			NOW
		);
		expect(code).toMatch(/^[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}$/);
		expect(expiresAt.getTime()).toBe(NOW + 60 * 60_000);
		expect(redeemJoinCode(database, code.replaceAll('-', '').toLowerCase(), NOW)).toEqual({
			joinCodeId: id,
			maxUses: 1,
			machineGroupIds: ['g1'],
			purpose: { kind: 'new-machine' }
		});
		expect(redeemJoinCode(database, code, NOW)).toMatchObject({ reason: 'used-code', status: 409 });
	});

	it('refuses an expired or unknown code', () => {
		const database = testDatabase();
		const { code } = createJoinCode(
			database,
			{ maxUses: 1, minutes: 60, machineGroupIds: [], createdBy: null },
			NOW
		);
		expect(redeemJoinCode(database, code, NOW + 60 * 60_000)).toMatchObject({
			reason: 'expired-code'
		});
		expect(redeemJoinCode(database, 'AAA-AAA-AAA', NOW)).toMatchObject({
			reason: 'invalid-code',
			status: 404
		});
	});

	it('allows a roll-out code up to its number of uses', () => {
		const database = testDatabase();
		const { id, code } = createJoinCode(
			database,
			{ maxUses: 3, minutes: 60, machineGroupIds: [], createdBy: null },
			NOW
		);
		for (let use = 0; use < 3; use += 1) {
			expect(redeemJoinCode(database, code, NOW)).toEqual({
				joinCodeId: id,
				maxUses: 3,
				machineGroupIds: [],
				purpose: { kind: 'new-machine' }
			});
		}
		expect(redeemJoinCode(database, code, NOW)).toMatchObject({ reason: 'used-code' });
	});

	it('keeps to the limits: 1 to 100 uses, up to 7 days', () => {
		const database = testDatabase();
		expect(() =>
			createJoinCode(
				database,
				{ maxUses: 101, minutes: 60, machineGroupIds: [], createdBy: null },
				NOW
			)
		).toThrow();
		expect(() =>
			createJoinCode(
				database,
				{ maxUses: 1, minutes: 7 * 24 * 60 + 1, machineGroupIds: [], createdBy: null },
				NOW
			)
		).toThrow();
	});
});

/** Enrols a machine with the code, as the agent would, and returns its id. */
function enrolWith(database: AppDatabase, code: string, name: string, now: number): string {
	const reply = enrolMachine(
		database,
		{
			code,
			publicKey: Buffer.alloc(32, 1).toString('base64'),
			hostname: name.toLowerCase(),
			name,
			osFamily: 'linux',
			target: 'x86_64-unknown-linux-gnu',
			agentVersion: '0.1.0'
		},
		SERVER_PUBLIC_KEY,
		now
	);
	if (isRefusal(reply)) {
		throw new Error(reply.message);
	}
	return reply.machineId;
}

describe('join code status (Add machine shows what happened to the code)', () => {
	it('is open with no machines until one enrols, then used up and names the machine', () => {
		const database = testDatabase();
		const { id, code, expiresAt } = createJoinCode(
			database,
			{ maxUses: 1, minutes: 60, machineGroupIds: [], createdBy: null },
			NOW
		);
		expect(joinCodeStatus(database, id, NOW)).toEqual({
			maxUses: 1,
			uses: 0,
			expiresAt,
			state: 'open',
			machines: []
		});
		const machineId = enrolWith(database, code, 'Build server', NOW + 5_000);
		expect(joinCodeStatus(database, id, NOW + 6_000)).toEqual({
			maxUses: 1,
			uses: 1,
			expiresAt,
			state: 'used-up',
			machines: [
				{ id: machineId, name: 'Build server', enrolledAt: new Date(NOW + 5_000), removed: false }
			]
		});
		// Used up stays used up after the expiry time passes.
		expect(joinCodeStatus(database, id, NOW + 61 * 60_000)?.state).toBe('used-up');
	});

	it('counts a roll-out code newest first, and keeps a removed machine marked as removed', () => {
		const database = testDatabase();
		const { id, code } = createJoinCode(
			database,
			{ maxUses: 3, minutes: 60, machineGroupIds: [], createdBy: null },
			NOW
		);
		const first = enrolWith(database, code, 'Alpha', NOW + 1_000);
		const second = enrolWith(database, code, 'Bravo', NOW + 2_000);
		removeMachine(database, first, crypto.randomUUID(), NOW + 3_000);
		const status = joinCodeStatus(database, id, NOW + 4_000);
		expect(status).toMatchObject({ maxUses: 3, uses: 2, state: 'open' });
		expect(status?.machines.map((machine) => [machine.id, machine.removed])).toEqual([
			[second, false],
			[first, true]
		]);
		enrolWith(database, code, 'Charlie', NOW + 5_000);
		expect(joinCodeStatus(database, id, NOW + 6_000)).toMatchObject({
			uses: 3,
			state: 'used-up'
		});
	});

	it('is expired once the time runs out unused, and unknown for an id it never made', () => {
		const database = testDatabase();
		const { id } = createJoinCode(
			database,
			{ maxUses: 1, minutes: 60, machineGroupIds: [], createdBy: null },
			NOW
		);
		expect(joinCodeStatus(database, id, NOW + 60 * 60_000 - 1)?.state).toBe('open');
		expect(joinCodeStatus(database, id, NOW + 60 * 60_000)).toMatchObject({
			uses: 0,
			state: 'expired',
			machines: []
		});
		expect(joinCodeStatus(database, crypto.randomUUID(), NOW)).toBeUndefined();
	});
});

describe('join codes name machine groups (SPEC-ACCESS A7)', () => {
	it('A7: a machine joins the groups its join code names when it enrols, single-use or roll-out', async () => {
		const database = testDatabase();
		const admin = await addTestUser(database, {
			email: 'ada@example.com',
			role: 'admin',
			password: null
		});
		const office = done(
			createGroup(database, 'machine', admin.id, { name: 'Office', description: '' }, NOW)
		);
		const lab = done(
			createGroup(database, 'machine', admin.id, { name: 'Lab', description: '' }, NOW)
		);
		const single = createJoinCode(
			database,
			{ maxUses: 1, minutes: 60, machineGroupIds: [office], createdBy: admin.id },
			NOW
		);
		const rollout = createJoinCode(
			database,
			{ maxUses: 10, minutes: 60, machineGroupIds: [office, lab], createdBy: admin.id },
			NOW
		);
		const first = enrolWithCode(database, single.code, 'reception', NOW);
		const second = enrolWithCode(database, rollout.code, 'lab-1', NOW);
		if (isRefusal(first) || isRefusal(second)) throw new Error('enrolment refused');
		const members = (id: string) => {
			const group = listMachineGroups(database).find((candidate) => candidate.id === id);
			return group?.membership.kind === 'chosen' ? group.membership.machineIds.toSorted() : [];
		};
		expect(members(office)).toEqual([first.machineId, second.machineId].toSorted());
		expect(members(lab)).toEqual([second.machineId]);
		expect(listAudit(database, 1)[0]).toMatchObject({
			kind: 'machine-enrolled',
			detail: { groups: 'Office, Lab' }
		});
	});

	it('A7: skips a group deleted since the code was made; the code request must name its groups', async () => {
		const database = testDatabase();
		const admin = await addTestUser(database, {
			email: 'ada@example.com',
			role: 'admin',
			password: null
		});
		const office = done(
			createGroup(database, 'machine', admin.id, { name: 'Office', description: '' }, NOW)
		);
		const { code } = createJoinCode(
			database,
			{ maxUses: 1, minutes: 60, machineGroupIds: [office], createdBy: admin.id },
			NOW
		);
		done(deleteGroup(database, 'machine', admin.id, office, NOW));
		expect(isRefusal(enrolWithCode(database, code, 'host', NOW))).toBe(false);
		expect(listAudit(database, 1)[0]?.detail).toMatchObject({ groups: 'none' });

		expect(createJoinCodeRequestSchema.safeParse({ maxUses: 1, minutes: 60 }).success).toBe(false);
		expect(
			createJoinCodeRequestSchema.safeParse({ maxUses: 1, minutes: 60, machineGroupIds: ['x'] })
				.success
		).toBe(false);
		const all = listMachineGroups(database)[0]?.id ?? '';
		expect(areChosenMachineGroups(database, [])).toBe(true);
		expect(areChosenMachineGroups(database, [all])).toBe(false);
		expect(areChosenMachineGroups(database, [office])).toBe(false);
		const early = listMachineGroups(database).find((group) => group.builtIn === 'early')?.id ?? '';
		expect(areChosenMachineGroups(database, [early])).toBe(true);
	});
});
