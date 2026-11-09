import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
	agentSocketMessageSchema,
	type LogBatchMessage
} from '#lib/schemas/agents/agent-protocol.ts';
import { agentLogRecords } from '#lib/server/database/schema.ts';
import { enrolFakeAgent, testDatabase } from '#tests/helpers/fake-agent.ts';
import { NOW } from '#tests/helpers/people.ts';
import { resetLogRates, storeLogBatch } from './agent-logs.ts';

const INSTANCE = '11111111-1111-4111-8111-111111111111';

function batch(first: number, count: number, instance = INSTANCE): LogBatchMessage {
	return {
		type: 'log-batch',
		instance,
		records: Array.from({ length: count }, (_, index) => ({
			seq: first + index,
			at: NOW - 1000 + index,
			level: 'info',
			source: 'agent',
			target: 'bmuster_agent::socket',
			text: `record ${first + index}`
		}))
	};
}

describe('agent log batches (SPEC-AGENT-LOGS AL6)', () => {
	afterEach(() => {
		resetLogRates();
	});

	it('AL6: stores a batch idempotently for the socket machine only and acknowledges its last seq', () => {
		const database = testDatabase();
		const one = enrolFakeAgent(database, NOW).machineId;
		const two = enrolFakeAgent(database, NOW).machineId;

		expect(storeLogBatch(database, one, batch(1, 3), NOW)).toEqual({
			kind: 'stored',
			ackSeq: 3,
			stored: 3
		});
		// Sent again after a reconnect, with one more: only the new record is stored.
		expect(storeLogBatch(database, one, batch(1, 4), NOW)).toEqual({
			kind: 'stored',
			ackSeq: 4,
			stored: 1
		});
		// The same instance and seq from another machine are that machine's own records.
		expect(storeLogBatch(database, two, batch(1, 2), NOW)).toMatchObject({ stored: 2 });

		const rows = database
			.select()
			.from(agentLogRecords)
			.where(eq(agentLogRecords.machineId, one))
			.all();
		expect(rows.map((row) => row.seq).sort()).toEqual([1, 2, 3, 4]);
		expect(rows[0]).toMatchObject({
			instance: INSTANCE,
			level: 'info',
			source: 'agent',
			target: 'bmuster_agent::socket',
			receivedAt: new Date(NOW)
		});
	});

	it('AL6: the socket contract caps records, text and batch size', () => {
		const parse = (value: unknown) => agentSocketMessageSchema.safeParse(value).success;
		expect(parse(batch(1, 500))).toBe(true);
		expect(parse(batch(1, 501))).toBe(false);
		expect(parse({ ...batch(1, 0) })).toBe(false);
		const long = batch(1, 1);
		const [record] = long.records;
		if (record === undefined) throw new Error('no record');
		expect(parse({ ...long, records: [{ ...record, text: 'x'.repeat(4096) }] })).toBe(true);
		expect(parse({ ...long, records: [{ ...record, text: 'x'.repeat(4097) }] })).toBe(false);
		expect(parse({ ...long, records: [{ ...record, seq: 0 }] })).toBe(false);
		expect(parse({ ...long, records: [{ ...record, source: 'shell' }] })).toBe(false);
		expect(parse({ ...long, instance: 'not-a-uuid' })).toBe(false);
	});

	it('AL6: more than 3000 records a minute wait unacknowledged until the bucket refills', () => {
		const database = testDatabase();
		const machine = enrolFakeAgent(database, NOW).machineId;
		for (let n = 0; n < 6; n += 1) {
			expect(storeLogBatch(database, machine, batch(1 + n * 500, 500), NOW)).toMatchObject({
				kind: 'stored'
			});
		}
		expect(storeLogBatch(database, machine, batch(3001, 500), NOW)).toEqual({
			kind: 'rate-limited'
		});
		// Ten seconds refill 500 records.
		expect(storeLogBatch(database, machine, batch(3001, 500), NOW + 10_000)).toMatchObject({
			kind: 'stored',
			ackSeq: 3500
		});
		expect(database.select().from(agentLogRecords).all()).toHaveLength(3500);
	});
});
