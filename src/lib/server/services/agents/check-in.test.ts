import { describe, expect, it } from 'vitest';
import {
	SAMPLE_INVENTORY,
	enrolFakeAgent,
	testDatabase,
	NO_RELEASES
} from '#tests/helpers/fake-agent.ts';
import { addTestUser } from '#tests/helpers/people.ts';
import { listAudit } from '../audit/audit.ts';
import { reportedStorage } from '../machines/machine-storage.ts';
import { recordCleanupStart } from '../machines/storage-cleanups.ts';
import { findMachine } from '../machines/machine-views.ts';
import { checkInRequestSchema } from '#lib/schemas/agents/agent-protocol.ts';
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
		update: { kind: 'no-launcher' as const },
		signedInUser: { kind: 'user' as const, name: 'jack' },
		load: { cpuPercent: 12.5, memoryUsedBytes: 4 * 1024 ** 3 },
		inventory,
		localUsers: { kind: 'unsupported' as const },
		checks: { kind: 'unreported' as const },
		storage: { kind: 'unreported' as const }
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
			machineName: 'Test machine',
			localUsers: { kind: 'unchanged' }
		});

		const machine = findMachine(database, agent.machineId, NOW + 1000, NO_RELEASES);
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
			network: [{ name: 'eth0', mac: '00:11:22:33:44:55', addresses: ['10.0.0.5'] }]
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

describe('the per-drive storage summary (SPEC-STORAGE S8)', () => {
	const drive = {
		mount: '/',
		sizeBytes: 100,
		freeBytes: 5,
		lastScan: {
			kind: 'complete' as const,
			startedAtMs: 1,
			finishedAtMs: 2,
			scannedBytes: 80,
			usedBytes: 95,
			files: 10,
			folders: 3,
			denied: 0
		},
		scanning: { kind: 'idle' as const }
	};

	it('older agents send none, and the last summary stays', () => {
		const database = testDatabase();
		const agent = enrolFakeAgent(database, NOW);
		const auth = { machineId: agent.machineId, checkInSeconds: 60 };
		const { storage: _ignored, ...older } = checkIn({ kind: 'unchanged', hash: HASH });
		expect(checkInRequestSchema.parse(older).storage).toEqual({ kind: 'unreported' });
		recordCheckIn(database, auth, checkIn({ kind: 'unchanged', hash: HASH }), NOW);
		expect(reportedStorage(database, agent.machineId)).toEqual({ kind: 'none' });
		recordCheckIn(
			database,
			auth,
			{
				...checkIn({ kind: 'unchanged', hash: HASH }),
				storage: { kind: 'reported', drives: [drive], cleanup: { kind: 'none' } }
			},
			NOW
		);
		recordCheckIn(database, auth, checkIn({ kind: 'unchanged', hash: HASH }), NOW + 60_000);
		expect(reportedStorage(database, agent.machineId)).toEqual({
			kind: 'reported',
			drives: [drive],
			reportedAt: new Date(NOW).toISOString()
		});
	});

	it('keeps only the latest report', () => {
		const database = testDatabase();
		const agent = enrolFakeAgent(database, NOW);
		const auth = { machineId: agent.machineId, checkInSeconds: 60 };
		const report = (freeBytes: number) => ({
			...checkIn({ kind: 'unchanged', hash: HASH }),
			storage: {
				kind: 'reported' as const,
				drives: [{ ...drive, freeBytes }],
				cleanup: { kind: 'none' as const }
			}
		});
		recordCheckIn(database, auth, report(5), NOW);
		recordCheckIn(database, auth, report(50), NOW + 60_000);
		const stored = reportedStorage(database, agent.machineId);
		expect(stored.kind === 'reported' ? stored.drives[0]?.freeBytes : undefined).toBe(50);
	});
});

describe('the check-in records a clean-up nobody watched (SPEC-STORAGE S19)', () => {
	it('records and audits the last run once', async () => {
		const database = testDatabase();
		const agent = enrolFakeAgent(database, NOW);
		const auth = { machineId: agent.machineId, checkInSeconds: 60 };
		const admin = await addTestUser(database, {
			email: 'ada@example.com',
			role: 'admin',
			password: null
		});
		const runId = crypto.randomUUID();
		recordCleanupStart(
			database,
			{ runId, machineId: agent.machineId, userId: admin.id, items: ['journal'] },
			NOW
		);
		const report = {
			...checkIn({ kind: 'unchanged', hash: HASH }),
			storage: {
				kind: 'reported' as const,
				drives: [],
				cleanup: {
					kind: 'interrupted' as const,
					runId,
					startedAtMs: NOW,
					items: [{ id: 'journal' as const, state: { kind: 'waiting' as const } }]
				}
			}
		};
		recordCheckIn(database, auth, report, NOW + 60_000);
		recordCheckIn(database, auth, report, NOW + 120_000);
		const entries = listAudit(database, 10).filter((entry) => entry.kind === 'storage-cleanup');
		expect(entries).toHaveLength(1);
		expect(entries[0]).toMatchObject({
			actorUserId: admin.id,
			detail: { result: 'Stopped before the end' }
		});
	});
});
