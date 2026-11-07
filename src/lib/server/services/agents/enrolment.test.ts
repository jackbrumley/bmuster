import { describe, expect, it } from 'vitest';
import { machines } from '../../database/schema.ts';
import { SERVER_PUBLIC_KEY, testDatabase } from '#tests/helpers/fake-agent.ts';
import { listAudit } from '../audit/audit.ts';
import { createJoinCode } from './join-codes.ts';
import { enrolMachine } from './enrolment.ts';

const NOW = 1_794_000_000_000;
const REQUEST = {
	publicKey: Buffer.alloc(32, 1).toString('base64'),
	hostname: 'build-01',
	name: 'Build server',
	osFamily: 'linux' as const,
	target: 'x86_64-unknown-linux-gnu',
	agentVersion: '0.1.0'
};

describe('enrolment (A4)', () => {
	it('creates the machine and returns its id and the server key', () => {
		const database = testDatabase();
		const { code } = createJoinCode(
			database,
			{ maxUses: 1, minutes: 60, machineGroupIds: [], createdBy: null },
			NOW
		);
		const reply = enrolMachine(database, { ...REQUEST, code }, SERVER_PUBLIC_KEY, NOW);
		expect(reply).toMatchObject({ serverPublicKey: SERVER_PUBLIC_KEY, checkInSeconds: 60 });
		expect(reply).toHaveProperty('machineId');
		const rows = database.select().from(machines).all();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			name: 'Build server',
			hostname: 'build-01',
			publicKey: REQUEST.publicKey
		});
	});

	it('refuses a bad code with a plain reason and creates nothing', () => {
		const database = testDatabase();
		const reply = enrolMachine(
			database,
			{ ...REQUEST, code: 'ZZZ-ZZZ-ZZZ' },
			SERVER_PUBLIC_KEY,
			NOW
		);
		expect(reply).toMatchObject({ refused: true, reason: 'invalid-code' });
		expect(database.select().from(machines).all()).toHaveLength(0);
		expect(listAudit(database, 10)).toEqual([]);
	});

	it('keeps the join code on the machine and audits the enrolment, saying which kind of code', () => {
		const database = testDatabase();
		const single = createJoinCode(
			database,
			{ maxUses: 1, minutes: 60, machineGroupIds: [], createdBy: null },
			NOW
		);
		const rollout = createJoinCode(
			database,
			{ maxUses: 25, minutes: 60, machineGroupIds: [], createdBy: null },
			NOW
		);
		enrolMachine(database, { ...REQUEST, code: single.code }, SERVER_PUBLIC_KEY, NOW);
		enrolMachine(
			database,
			{ ...REQUEST, name: 'Laptop 7', hostname: 'lap-07', code: rollout.code },
			SERVER_PUBLIC_KEY,
			NOW + 1
		);
		expect(
			database
				.select({ name: machines.name, joinCodeId: machines.joinCodeId })
				.from(machines)
				.orderBy(machines.enrolledAt)
				.all()
		).toEqual([
			{ name: 'Build server', joinCodeId: single.id },
			{ name: 'Laptop 7', joinCodeId: rollout.id }
		]);
		expect(listAudit(database, 10)).toMatchObject([
			{
				actorUserId: null,
				kind: 'machine-enrolled',
				target: 'Laptop 7',
				detail: {
					hostname: 'lap-07',
					system: 'linux (x86_64-unknown-linux-gnu)',
					code: 'roll-out'
				}
			},
			{
				actorUserId: null,
				kind: 'machine-enrolled',
				target: 'Build server',
				detail: { hostname: 'build-01', code: 'single use' }
			}
		]);
	});
});
