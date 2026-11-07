import { describe, expect, it } from 'vitest';
import { SAMPLE_INVENTORY, enrolFakeAgent, testDatabase } from '#tests/helpers/fake-agent.ts';
import { findMachine } from '../machines/machine-views.ts';
import { recordCheckIn } from './check-in.ts';

const NOW = 1_794_000_000_000;
const HASH = 'a'.repeat(64);

function checkIn(
	inventory:
		| { kind: 'unchanged'; hash: string }
		| { kind: 'full'; hash: string; data: typeof SAMPLE_INVENTORY }
) {
	return {
		agentVersion: '0.1.1',
		uptimeSeconds: 3600,
		signedInUser: { kind: 'user' as const, name: 'jack' },
		load: { cpuPercent: 12.5, memoryUsedBytes: 4 * 1024 ** 3 },
		inventory
	};
}

describe('check-in (A6)', () => {
	it('stores status and the full inventory, and shows them on the machine', () => {
		const database = testDatabase();
		const agent = enrolFakeAgent(database, NOW);
		const reply = recordCheckIn(
			database,
			{ machineId: agent.machineId, checkInSeconds: 60 },
			checkIn({ kind: 'full', hash: HASH, data: SAMPLE_INVENTORY }),
			NOW + 1000
		);
		expect(reply).toEqual({
			checkInSeconds: 60,
			inventoryWanted: false,
			machineName: 'Test machine'
		});

		const machine = findMachine(database, agent.machineId, NOW + 1000);
		expect(machine?.agentVersion).toBe('0.1.1');
		expect(machine?.live).toEqual({
			kind: 'known',
			cpuPercent: 12.5,
			memoryUsedBytes: 4 * 1024 ** 3,
			uptimeSeconds: 3600,
			signedInUser: { kind: 'user', name: 'jack' }
		});
		expect(machine?.inventory).toMatchObject({
			kind: 'known',
			osName: 'Ubuntu',
			updates: { kind: 'known', count: 3 },
			addresses: ['10.0.0.5']
		});
	});

	it('asks for the full inventory when it has none or a different one', () => {
		const database = testDatabase();
		const agent = enrolFakeAgent(database, NOW);
		const auth = { machineId: agent.machineId, checkInSeconds: 60 };
		expect(
			recordCheckIn(database, auth, checkIn({ kind: 'unchanged', hash: HASH }), NOW).inventoryWanted
		).toBe(true);
		recordCheckIn(
			database,
			auth,
			checkIn({ kind: 'full', hash: HASH, data: SAMPLE_INVENTORY }),
			NOW
		);
		expect(
			recordCheckIn(database, auth, checkIn({ kind: 'unchanged', hash: HASH }), NOW).inventoryWanted
		).toBe(false);
		expect(
			recordCheckIn(database, auth, checkIn({ kind: 'unchanged', hash: 'b'.repeat(64) }), NOW)
				.inventoryWanted
		).toBe(true);
	});
});
