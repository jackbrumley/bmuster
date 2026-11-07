import { describe, expect, it } from 'vitest';
import { enrolFakeAgent, testDatabase } from '#tests/helpers/fake-agent.ts';
import { agentConnected, agentDisconnected } from '../agents/live-agents.ts';
import { findMachine, listMachines, removeMachine } from './machine-views.ts';

const NOW = 1_794_000_000_000;

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
		removeMachine(database, removed.machineId, NOW);
		expect(listMachines(database, NOW).map((machine) => machine.id)).toEqual([kept.machineId]);
		expect(findMachine(database, removed.machineId, NOW)).toBeUndefined();
	});
});
