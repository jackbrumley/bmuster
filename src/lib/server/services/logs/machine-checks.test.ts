import { afterEach, describe, expect, it } from 'vitest';
import {
	agentSocketMessageSchema,
	checkInRequestSchema,
	type ServerSocketMessage
} from '#lib/schemas/agents/agent-protocol.ts';
import type { CheckResultWire } from '#lib/schemas/logs/checks.ts';
import { listAudit } from '#lib/server/services/audit/audit.ts';
import { enrolFakeAgent, testDatabase } from '#tests/helpers/fake-agent.ts';
import { addTestUser, NOW } from '#tests/helpers/people.ts';
import { recordCheckIn } from '../agents/check-in.ts';
import {
	readMachineChecks,
	requestChecks,
	resetCheckRequests,
	storeCheckInChecks,
	storeCheckResults
} from './machine-checks.ts';

function result(id: string, status: CheckResultWire['status'], detail: string): CheckResultWire {
	return { id, title: id, status, detail, durationMs: 12, checkedAt: NOW - 1000 };
}

describe('machine checks (SPEC-DIAGNOSTICS D9)', () => {
	afterEach(() => {
		resetCheckRequests();
	});

	it('D9: an older agent is unreported; a check-in stores the latest set and pending never hides it', () => {
		const database = testDatabase();
		const { machineId } = enrolFakeAgent(database, NOW);
		expect(readMachineChecks(database, machineId)).toEqual({ kind: 'unreported' });
		expect(readMachineChecks(database, crypto.randomUUID())).toBeUndefined();

		// A check-in without `checks` (an agent before 0.4.3) reads as unreported.
		const older = checkInRequestSchema.parse({
			agentVersion: '0.4.2',
			uptimeSeconds: 1,
			signedInUser: { kind: 'none' },
			load: { cpuPercent: 1, memoryUsedBytes: 1 },
			inventory: { kind: 'unchanged', hash: 'a'.repeat(64) },
			update: { kind: 'no-launcher' }
		});
		expect(older.checks).toEqual({ kind: 'unreported' });
		recordCheckIn(database, { machineId, checkInSeconds: 60 }, older, NOW);
		expect(readMachineChecks(database, machineId)).toEqual({ kind: 'unreported' });

		storeCheckInChecks(database, machineId, { kind: 'pending' }, NOW);
		expect(readMachineChecks(database, machineId)).toEqual({
			kind: 'pending',
			receivedIso: new Date(NOW).toISOString()
		});

		recordCheckIn(
			database,
			{ machineId, checkInSeconds: 60 },
			{
				...older,
				checks: {
					kind: 'results',
					results: [
						result('systemd-run', 'pass', 'ran /bin/true'),
						result('terminal-pty', 'fail', 'Failed to set up standard input: Permission denied')
					]
				}
			},
			NOW + 1000
		);
		const stored = readMachineChecks(database, machineId);
		expect(stored).toMatchObject({
			kind: 'results',
			receivedIso: new Date(NOW + 1000).toISOString(),
			results: [
				{ id: 'systemd-run', status: 'pass', checkedAtIso: new Date(NOW - 1000).toISOString() },
				{ id: 'terminal-pty', status: 'fail' }
			]
		});

		// After a restart the agent says pending again: the last results stay.
		storeCheckInChecks(database, machineId, { kind: 'pending' }, NOW + 2000);
		expect(readMachineChecks(database, machineId)).toEqual(stored);

		// Results from the live socket replace the set.
		storeCheckResults(
			database,
			machineId,
			[result('uinput', 'not-applicable', 'none')],
			NOW + 3000
		);
		expect(readMachineChecks(database, machineId)).toMatchObject({
			kind: 'results',
			results: [{ id: 'uinput', status: 'not-applicable' }]
		});
	});

	it('D9: the socket message is bounded and run-checks carries nothing', () => {
		const message = agentSocketMessageSchema.parse({
			type: 'checks',
			results: [result('journal', 'pass', 'one line')]
		});
		expect(message.type).toBe('checks');
		expect(
			agentSocketMessageSchema.safeParse({
				type: 'checks',
				results: [result('journal', 'pass', 'x'.repeat(2049))]
			}).success
		).toBe(false);
		expect(
			agentSocketMessageSchema.safeParse({
				type: 'checks',
				results: Array.from({ length: 33 }, (_, index) => result(`c${index}`, 'pass', ''))
			}).success
		).toBe(false);
		expect(
			agentSocketMessageSchema.safeParse({
				type: 'checks',
				results: [result('Not An Id', 'pass', '')]
			}).success
		).toBe(false);
	});

	it('D9: Run checks goes to a connected agent once a minute, audited', async () => {
		const database = testDatabase();
		const admin = await addTestUser(database, {
			email: 'checks@example.com',
			role: 'admin',
			password: null
		});
		const { machineId } = enrolFakeAgent(database, NOW);
		const sent: ServerSocketMessage[] = [];
		const online = (message: ServerSocketMessage) => {
			sent.push(message);
			return true;
		};

		expect(requestChecks(database, crypto.randomUUID(), admin.id, online, NOW)).toEqual({
			kind: 'not-found'
		});
		expect(requestChecks(database, machineId, admin.id, () => false, NOW)).toEqual({
			kind: 'offline'
		});
		expect(requestChecks(database, machineId, admin.id, online, NOW)).toEqual({
			kind: 'requested'
		});
		expect(sent).toEqual([{ type: 'run-checks' }]);
		expect(requestChecks(database, machineId, admin.id, online, NOW + 30_000)).toEqual({
			kind: 'too-soon',
			waitSeconds: 30
		});
		expect(requestChecks(database, machineId, admin.id, online, NOW + 60_000)).toEqual({
			kind: 'requested'
		});
		const audited = listAudit(database, 20).filter(
			(entry) => entry.kind === 'agent-checks-requested'
		);
		expect(audited).toHaveLength(2);
		expect(audited[0]).toMatchObject({ actorUserId: admin.id, target: 'Test machine' });
	});
});
