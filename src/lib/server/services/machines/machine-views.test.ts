import { describe, expect, it } from 'vitest';
import { enrolFakeAgent, testDatabase } from '#tests/helpers/fake-agent.ts';
import { agentConnected, agentDisconnected } from '../agents/live-agents.ts';
import { listAudit } from '../audit/audit.ts';
import { findMachine, listMachines, removeMachine } from './machine-views.ts';

const NOW = 1_794_000_000_000;
const ADMIN_ID = crypto.randomUUID();

describe('machine status (A7, A8)', () => {
	it('is online within 3 check-in intervals of the last contact, then offline with its last-seen time', () => {
		const database = testDatabase();
		const agent = enrolFakeAgent(database, NOW);
		expect(findMachine(database, agent.machineId, NOW + 179_000)?.status).toEqual({
			kind: 'online'
		});
		expect(findMachine(database, agent.machineId, NOW + 180_000)?.status).toEqual({
			kind: 'offline',
			lastSeenIso: new Date(NOW).toISOString()
		});
	});

	it('is online while the live socket is open, whatever the last check-in', () => {
		const database = testDatabase();
		const agent = enrolFakeAgent(database, NOW);
		const peer = { send: () => undefined, close: () => undefined };
		agentConnected(agent.machineId, peer);
		expect(findMachine(database, agent.machineId, NOW + 3_600_000)?.status).toEqual({
			kind: 'online'
		});
		agentDisconnected(agent.machineId, peer);
		expect(findMachine(database, agent.machineId, NOW + 3_600_000)?.status.kind).toBe('offline');
	});

	it('shows a new machine with its inventory pending, and hides removed machines', () => {
		const database = testDatabase();
		const kept = enrolFakeAgent(database, NOW);
		const removed = enrolFakeAgent(database, NOW);
		expect(findMachine(database, kept.machineId, NOW)?.inventory).toEqual({ kind: 'pending' });
		removeMachine(database, removed.machineId, ADMIN_ID, NOW);
		expect(listMachines(database, NOW).map((machine) => machine.id)).toEqual([kept.machineId]);
		expect(findMachine(database, removed.machineId, NOW)).toBeUndefined();
	});

	it('audits a removal with the admin who removed it, and refuses an unknown or already removed machine', () => {
		const database = testDatabase();
		const agent = enrolFakeAgent(database, NOW);
		expect(removeMachine(database, agent.machineId, ADMIN_ID, NOW + 1)).toBe(true);
		expect(listAudit(database, 1)).toMatchObject([
			{
				actorUserId: ADMIN_ID,
				kind: 'machine-removed',
				target: 'Test machine',
				detail: { hostname: 'test-host' }
			}
		]);
		expect(removeMachine(database, crypto.randomUUID(), ADMIN_ID, NOW + 2)).toBe(false);
		expect(removeMachine(database, agent.machineId, ADMIN_ID, NOW + 3)).toBe(false);
		// Enrolment and the one removal; the second attempt writes nothing.
		expect(listAudit(database, 10)).toHaveLength(2);
	});
});
