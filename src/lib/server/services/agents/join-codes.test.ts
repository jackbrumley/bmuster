import { describe, expect, it } from 'vitest';
import { testDatabase } from '#tests/helpers/fake-agent.ts';
import { createJoinCode, redeemJoinCode } from './join-codes.ts';

const NOW = 1_794_000_000_000;

describe('join codes (A1, A2)', () => {
	it('makes a readable code that works once, typed in any case with or without hyphens', () => {
		const database = testDatabase();
		const { code, expiresAt } = createJoinCode(
			database,
			{ maxUses: 1, minutes: 60, machineGroupIds: ['g1'], createdBy: null },
			NOW
		);
		expect(code).toMatch(/^[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}$/);
		expect(expiresAt.getTime()).toBe(NOW + 60 * 60_000);
		expect(redeemJoinCode(database, code.replaceAll('-', '').toLowerCase(), NOW)).toEqual({
			machineGroupIds: ['g1']
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
		const { code } = createJoinCode(
			database,
			{ maxUses: 3, minutes: 60, machineGroupIds: [], createdBy: null },
			NOW
		);
		for (let use = 0; use < 3; use += 1) {
			expect(redeemJoinCode(database, code, NOW)).toEqual({ machineGroupIds: [] });
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
