import { RECORDS_PER_MINUTE } from '#lib/domain/logs/logs.ts';
import type { LogBatchMessage } from '#lib/schemas/agents/agent-protocol.ts';
import type { Queryable } from '../../database/connection.ts';
import { agentLogRecords } from '../../database/schema.ts';
import { serverLog } from './server-log.ts';

/**
 * Agent log batches from the live socket (SPEC-AGENT-LOGS 2). `machineId` is the socket's
 * authenticated machine, never anything in the message, so a machine can only write its own
 * records. The key (machine, instance, seq) makes a resent record a no-op.
 *
 * Rates: each machine has a bucket of 3000 records that refills at 3000 a minute. A batch larger
 * than what is left is neither stored nor acknowledged; the agent paces itself the same way and
 * sends it again later, so nothing is lost from an agent that keeps to the rule.
 */
export type BatchResult =
	{ kind: 'stored'; ackSeq: number; stored: number } | { kind: 'rate-limited' };

type Bucket = { tokens: number; atMs: number; warnedAtMs: number };

const REFILL_PER_MS = RECORDS_PER_MINUTE / 60_000;

/** In memory: a restart (or a dev reload) starts every machine with a full bucket. */
const buckets = new Map<string, Bucket>();

/** Takes `count` records from the machine's bucket, or refuses. */
function admit(machineId: string, count: number, now: number): boolean {
	const all = buckets;
	const bucket = all.get(machineId) ?? {
		tokens: RECORDS_PER_MINUTE,
		atMs: now,
		warnedAtMs: 0
	};
	bucket.tokens = Math.min(
		RECORDS_PER_MINUTE,
		bucket.tokens + Math.max(0, now - bucket.atMs) * REFILL_PER_MS
	);
	bucket.atMs = now;
	all.set(machineId, bucket);
	if (count > bucket.tokens) {
		if (now - bucket.warnedAtMs >= 60_000) {
			bucket.warnedAtMs = now;
			serverLog(
				'warn',
				'logs',
				`An agent sent more than ${RECORDS_PER_MINUTE} log records a minute; a batch of ${count} waits.`,
				machineId,
				now
			);
		}
		return false;
	}
	bucket.tokens -= count;
	return true;
}

export function storeLogBatch(
	database: Queryable,
	machineId: string,
	batch: LogBatchMessage,
	now: number
): BatchResult {
	if (!admit(machineId, batch.records.length, now)) {
		return { kind: 'rate-limited' };
	}
	const receivedAt = new Date(now);
	const result = database
		.insert(agentLogRecords)
		.values(
			batch.records.map((record) => ({
				machineId,
				instance: batch.instance,
				seq: record.seq,
				at: new Date(record.at),
				level: record.level,
				source: record.source,
				target: record.target,
				text: record.text,
				receivedAt
			}))
		)
		.onConflictDoNothing()
		.run();
	return {
		kind: 'stored',
		ackSeq: Math.max(...batch.records.map((record) => record.seq)),
		stored: result.changes
	};
}

/** Tests: every machine starts with a full bucket. */
export function resetLogRates(): void {
	buckets.clear();
}
