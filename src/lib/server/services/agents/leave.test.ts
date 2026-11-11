import { describe, expect, it } from 'vitest';
import { machines } from '../../database/schema.ts';
import { enrolFakeAgent, testDatabase, NO_RELEASES } from '#tests/helpers/fake-agent.ts';
import { NOW } from '#tests/helpers/people.ts';
import { listAudit } from '../audit/audit.ts';
import { findMachine, listMachines } from '../machines/machine-views.ts';
import { authenticateAgent } from './agent-auth.ts';
import { isRefusal } from './agent-refusal.ts';
import { leaveRequestSchema } from '#lib/schemas/agents/agent-protocol.ts';
import { recordLeave } from './leave.ts';
import { agentConnected, isAgentConnected } from './live-agents.ts';

const CHECK_IN = '/agent/v1/check-in';
const LEAVE = '/agent/v1/leave';

describe('leaving a server (SPEC-AGENT-LOCAL 3)', () => {
	it('marks a moved machine moved, keeps its history and refuses it from then on', () => {
		const database = testDatabase();
		const agent = enrolFakeAgent(database, NOW);
		const closed: { code: number; reason: string }[] = [];
		agentConnected(agent.machineId, {
			send: () => undefined,
			close: (code, reason) => closed.push({ code, reason })
		});

		// The leave is itself a signed request, checked like any other.
		const auth = authenticateAgent(
			database,
			agent.signed('POST', LEAVE, '{"reason":"moved"}', NOW + 1),
			NOW + 1
		);
		if (isRefusal(auth)) throw new Error(auth.message);
		recordLeave(database, auth, 'moved', NOW + 1);

		const row = database.select().from(machines).get();
		expect(row?.movedAt).toEqual(new Date(NOW + 1));
		expect(row?.removedAt).toEqual(new Date(NOW + 1));
		// Gone from the lists and pages, like a removed machine; the row stays for the history.
		expect(listMachines(database, NOW + 2, NO_RELEASES)).toEqual([]);
		expect(findMachine(database, agent.machineId, NOW + 2, NO_RELEASES)).toBeUndefined();
		expect(closed).toEqual([{ code: 4001, reason: 'revoked' }]);
		expect(isAgentConnected(agent.machineId)).toBe(false);

		expect(
			authenticateAgent(database, agent.signed('POST', CHECK_IN, '{}', NOW + 3), NOW + 3)
		).toMatchObject({
			refused: true,
			reason: 'revoked',
			message: 'This machine moved to another BMuster server.'
		});
		expect(listAudit(database, 1)[0]).toMatchObject({
			kind: 'machine-moved',
			actorUserId: null,
			target: 'Test machine',
			detail: { hostname: 'test-host' }
		});
	});

	it('records an uninstall from the local page as the machine leaving, not moving', () => {
		const database = testDatabase();
		const agent = enrolFakeAgent(database, NOW);
		recordLeave(
			database,
			{ machineId: agent.machineId, checkInSeconds: 60 },
			'uninstalled',
			NOW + 1
		);

		const row = database.select().from(machines).get();
		expect(row?.movedAt).toBeNull();
		expect(row?.removedAt).toEqual(new Date(NOW + 1));
		expect(
			authenticateAgent(database, agent.signed('POST', CHECK_IN, '{}', NOW + 2), NOW + 2)
		).toMatchObject({
			refused: true,
			reason: 'revoked',
			message: 'This machine was removed from the server.'
		});
		expect(listAudit(database, 1)[0]?.kind).toBe('machine-uninstalled');
	});

	it('records BMuster removed at the machine by a local administrator (SPEC-LOCAL-PAGE-TRANSPARENCY T7)', () => {
		const database = testDatabase();
		const agent = enrolFakeAgent(database, NOW);
		const body = '{"reason":"removed-at-machine"}';
		// Signed with the machine's own key, like every agent request.
		const auth = authenticateAgent(database, agent.signed('POST', LEAVE, body, NOW + 1), NOW + 1);
		if (isRefusal(auth)) throw new Error(auth.message);
		const parsed = leaveRequestSchema.parse(JSON.parse(body));
		recordLeave(database, auth, parsed.reason, NOW + 1);

		const row = database.select().from(machines).get();
		expect(row?.movedAt).toBeNull();
		expect(row?.removedAt).toEqual(new Date(NOW + 1));
		expect(
			authenticateAgent(database, agent.signed('POST', CHECK_IN, '{}', NOW + 2), NOW + 2)
		).toMatchObject({ refused: true, reason: 'revoked' });
		expect(listAudit(database, 1)[0]).toMatchObject({
			kind: 'machine-removed-at-machine',
			actorUserId: null,
			target: 'Test machine',
			detail: { hostname: 'test-host' }
		});
	});

	it('refuses a second leave with revoked, which the agent takes as done', () => {
		const database = testDatabase();
		const agent = enrolFakeAgent(database, NOW);
		recordLeave(database, { machineId: agent.machineId, checkInSeconds: 60 }, 'moved', NOW + 1);
		expect(
			authenticateAgent(
				database,
				agent.signed('POST', LEAVE, '{"reason":"moved"}', NOW + 2),
				NOW + 2
			)
		).toMatchObject({ refused: true, reason: 'revoked' });
		expect(listAudit(database, 5).filter((entry) => entry.kind === 'machine-moved')).toHaveLength(
			1
		);
	});
});
