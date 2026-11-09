import { describe, expect, it } from 'vitest';
import { agentLogRecords, serverLogRecords } from '#lib/server/database/schema.ts';
import { testDatabase } from '#tests/helpers/fake-agent.ts';
import { NOW } from '#tests/helpers/people.ts';
import { pruneLogs, RETENTION } from './log-retention.ts';

const DAY = 24 * 60 * 60 * 1000;

describe('log retention (SPEC-AGENT-LOGS AL7)', () => {
	it('AL7: keeps seven days, at most 100 000 per machine and 200 000 server records', () => {
		expect(RETENTION).toEqual({ maxAgeMs: 7 * DAY, perMachine: 100_000, server: 200_000 });
	});

	it('AL7: prunes by age and by count per machine and for the server', () => {
		const database = testDatabase();
		const agentRow = (machineId: string, seq: number, at: number) => ({
			machineId,
			instance: 'i',
			seq,
			at: new Date(at),
			level: 'info' as const,
			source: 'agent' as const,
			target: 't',
			text: `${machineId} ${seq}`,
			receivedAt: new Date(at)
		});
		database
			.insert(agentLogRecords)
			.values([
				agentRow('old', 1, NOW - 8 * DAY),
				agentRow('busy', 1, NOW - 3000),
				agentRow('busy', 2, NOW - 2000),
				agentRow('busy', 3, NOW - 1000),
				agentRow('busy', 4, NOW - 500),
				// A machine that was removed keeps its records until they age out.
				agentRow('removed', 1, NOW - 6 * DAY)
			])
			.run();
		const serverRow = (seq: number, at: number) => ({
			instance: 's',
			seq,
			at: new Date(at),
			level: 'info' as const,
			area: 'agents',
			machineId: null,
			text: `server ${seq}`
		});
		database
			.insert(serverLogRecords)
			.values([
				serverRow(1, NOW - 10 * DAY),
				serverRow(2, NOW - 3000),
				serverRow(3, NOW - 2000),
				serverRow(4, NOW - 1000)
			])
			.run();

		expect(pruneLogs(database, NOW, { maxAgeMs: 7 * DAY, perMachine: 2, server: 2 })).toEqual({
			agentRecords: 3,
			serverRecords: 2
		});
		expect(
			database
				.select({ text: agentLogRecords.text })
				.from(agentLogRecords)
				.all()
				.map((row) => row.text)
				.sort()
		).toEqual(['busy 3', 'busy 4', 'removed 1']);
		expect(
			database
				.select({ text: serverLogRecords.text })
				.from(serverLogRecords)
				.all()
				.map((row) => row.text)
				.sort()
		).toEqual(['server 3', 'server 4']);
		expect(pruneLogs(database, NOW, RETENTION)).toEqual({ agentRecords: 0, serverRecords: 0 });
	});
});
