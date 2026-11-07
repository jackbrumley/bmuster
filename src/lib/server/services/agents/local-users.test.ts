import { describe, expect, it } from 'vitest';
import { SAMPLE_INVENTORY, enrolFakeAgent, testDatabase } from '#tests/helpers/fake-agent.ts';
import { addTestUser, NOW } from '#tests/helpers/people.ts';
import type { LocalUsersHeld } from '#lib/schemas/agents/agent-protocol.ts';
import { checkInRequestSchema } from '#lib/schemas/agents/agent-protocol.ts';
import { machines } from '../../database/schema.ts';
import type { AppDatabase } from '../../database/connection.ts';
import { disableUser } from '../users/users.ts';
import { recordCheckIn } from './check-in.ts';
import { localUsersList } from './local-users.ts';

function checkIn(database: AppDatabase, machineId: string, localUsers: LocalUsersHeld) {
	return recordCheckIn(
		database,
		{ machineId, checkInSeconds: 60 },
		{
			agentVersion: '0.3.0',
			uptimeSeconds: 1,
			update: { kind: 'no-launcher' as const },
			signedInUser: { kind: 'none' },
			load: { cpuPercent: 1, memoryUsedBytes: 1 },
			inventory: { kind: 'full', hash: 'c'.repeat(64), data: SAMPLE_INVENTORY },
			localUsers
		},
		NOW + 1
	).localUsers;
}

describe('the list of people for the local page (SPEC-AGENT-LOCAL 7)', () => {
	it('P4: is sent only when the agent holds a different one', async () => {
		const database = testDatabase();
		const ada = await addTestUser(database, {
			email: 'ada@example.com',
			role: 'admin',
			password: null
		});
		const agent = enrolFakeAgent(database, NOW);

		const first = checkIn(database, agent.machineId, { kind: 'none' });
		if (first.kind !== 'list') throw new Error('no list');
		expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
		expect(first.users).toEqual([{ userId: ada.id, name: 'ada' }]);
		expect(checkIn(database, agent.machineId, { kind: 'held', hash: first.hash })).toEqual({
			kind: 'unchanged'
		});
		expect(checkIn(database, agent.machineId, { kind: 'held', hash: 'stale' })).toMatchObject({
			kind: 'list',
			hash: first.hash
		});
	});

	it('P4: changes when the admins change, sorted by id, without disabled people or members', async () => {
		const database = testDatabase();
		const ada = await addTestUser(database, {
			email: 'ada@example.com',
			role: 'admin',
			password: null
		});
		await addTestUser(database, { email: 'mo@example.com', role: 'member', password: null });
		const before = localUsersList(database);
		const bo = await addTestUser(database, {
			email: 'bo@example.com',
			role: 'admin',
			password: null
		});
		const after = localUsersList(database);
		expect(after.hash).not.toBe(before.hash);
		expect(after.users.map((user) => user.userId)).toEqual([ada.id, bo.id].toSorted());

		disableUser(database, ada.id, bo.id, NOW + 2);
		expect(localUsersList(database)).toEqual(before);
	});

	it('sends older agents nothing and remembers which codes the agent takes', async () => {
		const database = testDatabase();
		await addTestUser(database, { email: 'ada@example.com', role: 'admin', password: null });
		const agent = enrolFakeAgent(database, NOW);
		const localCodes = () =>
			database.select({ localCodes: machines.localCodes }).from(machines).get();

		// An older agent's check-in has no localUsers at all.
		const old = checkInRequestSchema.parse({
			agentVersion: '0.2.0',
			uptimeSeconds: 1,
			update: { kind: 'no-launcher' as const },
			signedInUser: { kind: 'none' },
			load: { cpuPercent: 1, memoryUsedBytes: 1 },
			inventory: { kind: 'unchanged', hash: 'c'.repeat(64) }
		});
		expect(old.localUsers).toEqual({ kind: 'unsupported' });
		expect(checkIn(database, agent.machineId, old.localUsers)).toEqual({ kind: 'unchanged' });
		expect(localCodes()).toEqual({ localCodes: 'shared' });

		checkIn(database, agent.machineId, { kind: 'none' });
		expect(localCodes()).toEqual({ localCodes: 'per-person' });
	});
});
