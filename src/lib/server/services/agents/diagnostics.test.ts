import { afterEach, describe, expect, it, vi } from 'vitest';
import { toConsoleUser } from '#lib/server/services/users/users.ts';
import { enrolFakeAgent, testDatabase } from '#tests/helpers/fake-agent.ts';
import { addTestUser, NOW } from '#tests/helpers/people.ts';
import { listAudit } from '../audit/audit.ts';
import { receiveAgentDiagnostics, requestAgentDiagnostics } from './diagnostics.ts';

describe('agent diagnostics requests', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('returns only the correlated machine reply and audits counts without log text', async () => {
		const database = testDatabase();
		const agent = enrolFakeAgent(database, NOW);
		const admin = toConsoleUser(
			await addTestUser(database, {
				email: 'diagnostics@example.com',
				role: 'admin',
				password: null
			})
		);
		const resultPromise = requestAgentDiagnostics(
			database,
			agent.machineId,
			admin.id,
			(message) => {
				if (message.type !== 'diagnostics-request') {
					return false;
				}
				expect(
					receiveAgentDiagnostics('another-machine', {
						type: 'diagnostics',
						requestId: message.requestId,
						agentVersion: '0.3.1',
						capturedAtMs: NOW,
						lines: ['private log detail'],
						truncated: false,
						journal: { kind: 'unsupported' }
					})
				).toBe(false);
				receiveAgentDiagnostics(agent.machineId, {
					type: 'diagnostics',
					requestId: message.requestId,
					agentVersion: '0.3.1',
					capturedAtMs: NOW,
					lines: ['private log detail'],
					truncated: false,
					journal: { kind: 'available', lines: ['unit failed'], truncated: false }
				});
				return true;
			},
			NOW
		);

		expect(await resultPromise).toMatchObject({
			kind: 'received',
			message: { lines: ['private log detail'], journal: { kind: 'available' } }
		});
		expect(
			listAudit(database, 10).find((entry) => entry.kind === 'agent-logs-viewed')
		).toMatchObject({
			actorUserId: admin.id,
			target: 'Test machine',
			detail: { lines: '1', journalLines: '1' }
		});
		expect(JSON.stringify(listAudit(database, 10))).not.toContain('private log detail');
		expect(
			await requestAgentDiagnostics(database, agent.machineId, admin.id, () => true, NOW + 1)
		).toEqual({ kind: 'rate-limited' });
	});

	it('reports offline and unknown machines without creating a pending reply', async () => {
		const database = testDatabase();
		const agent = enrolFakeAgent(database, NOW);
		const admin = toConsoleUser(
			await addTestUser(database, { email: 'offline@example.com', role: 'admin', password: null })
		);
		expect(
			await requestAgentDiagnostics(database, agent.machineId, admin.id, () => false, NOW)
		).toEqual({ kind: 'offline' });
		expect(
			await requestAgentDiagnostics(database, crypto.randomUUID(), admin.id, () => true, NOW)
		).toEqual({ kind: 'not-found' });
	});

	it('times out an unanswered request and lets the admin retry after the rate window', async () => {
		const database = testDatabase();
		const agent = enrolFakeAgent(database, NOW);
		const admin = toConsoleUser(
			await addTestUser(database, { email: 'timeout@example.com', role: 'admin', password: null })
		);
		vi.useFakeTimers();
		const result = requestAgentDiagnostics(
			database,
			agent.machineId,
			admin.id,
			() => true,
			NOW + 30_000
		);
		await vi.advanceTimersByTimeAsync(10_000);
		await expect(result).resolves.toEqual({ kind: 'timed-out' });
		await expect(
			requestAgentDiagnostics(database, agent.machineId, admin.id, () => false, NOW + 40_001)
		).resolves.toEqual({ kind: 'offline' });
	});
});
