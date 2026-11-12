import { inUseLabel } from '#lib/domain/sessions/session.ts';
import { describe, expect, it } from 'vitest';
import { enrolFakeAgent, testDatabase, NO_RELEASES } from '#tests/helpers/fake-agent.ts';
import { listAudit } from '../audit/audit.ts';
import { sessionRelay } from '../sessions/relay.ts';
import { findMachine, listMachines, removeMachine } from './machine-views.ts';

const NOW = 1_794_000_000_000;
const ADMIN_ID = crypto.randomUUID();

describe('machine status (A7, A8)', () => {
	it('without a live socket, is online within 3 check-in intervals of the last contact, then offline since then (SPEC-PRESENCE P7)', () => {
		const database = testDatabase();
		const agent = enrolFakeAgent(database, NOW);
		expect(findMachine(database, agent.machineId, NOW + 179_000, NO_RELEASES)?.status).toEqual({
			kind: 'online'
		});
		expect(findMachine(database, agent.machineId, NOW + 180_000, NO_RELEASES)?.status).toEqual({
			kind: 'offline',
			sinceIso: new Date(NOW).toISOString()
		});
	});

	it('shows a new machine with its inventory pending, and hides removed machines', () => {
		const database = testDatabase();
		const kept = enrolFakeAgent(database, NOW);
		const removed = enrolFakeAgent(database, NOW);
		expect(findMachine(database, kept.machineId, NOW, NO_RELEASES)?.inventory).toEqual({
			kind: 'pending'
		});
		removeMachine(database, removed.machineId, ADMIN_ID, NOW);
		expect(listMachines(database, NOW, NO_RELEASES).map((machine) => machine.id)).toEqual([
			kept.machineId
		]);
		expect(findMachine(database, removed.machineId, NOW, NO_RELEASES)).toBeUndefined();
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

describe('in use (SPEC-SESSIONS T8)', () => {
	it('shows who has a session open on the machine, until it ends', () => {
		const database = testDatabase();
		const agent = enrolFakeAgent(database, NOW);
		const sessionId = crypto.randomUUID();
		sessionRelay().start(
			{
				id: sessionId,
				machineId: agent.machineId,
				userId: ADMIN_ID,
				userName: 'Kim',
				viewer: { kind: 'user' },
				kind: 'terminal',
				shell: 'bash',
				ip: '192.0.2.1',
				openedAt: NOW
			},
			() => undefined,
			() => undefined
		);
		expect(findMachine(database, agent.machineId, NOW, NO_RELEASES)?.inUse).toEqual([
			{ kind: 'terminal', userName: 'Kim' }
		]);
		expect(listMachines(database, NOW, NO_RELEASES)[0]?.inUse).toEqual([
			{ kind: 'terminal', userName: 'Kim' }
		]);
		sessionRelay().end(sessionId, 'closed', 'done');
		expect(findMachine(database, agent.machineId, NOW, NO_RELEASES)?.inUse).toEqual([]);
	});

	it('R17: a desktop session says whether it controls, as "desktop (control) by Kim"', () => {
		const database = testDatabase();
		const agent = enrolFakeAgent(database, NOW);
		const sessionId = crypto.randomUUID();
		sessionRelay().start(
			{
				id: sessionId,
				machineId: agent.machineId,
				userId: ADMIN_ID,
				userName: 'Kim',
				viewer: { kind: 'user' },
				kind: 'desktop',
				mode: 'control',
				ip: '192.0.2.1',
				openedAt: NOW
			},
			() => undefined,
			() => undefined
		);
		const inUse = findMachine(database, agent.machineId, NOW, NO_RELEASES)?.inUse ?? [];
		expect(inUseLabel(inUse)).toBe('desktop (control) by Kim');
		expect(inUseLabel([...inUse, { kind: 'terminal', userName: 'Lee' }])).toBe(
			'desktop (control) by Kim, terminal by Lee'
		);
		sessionRelay().end(sessionId, 'closed', 'done');
	});
});
