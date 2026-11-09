import { and, eq, isNull } from 'drizzle-orm';
import { MAX_VERBOSE_MS } from '#lib/domain/logs/logs.ts';
import type { ServerSocketMessage } from '#lib/schemas/agents/agent-protocol.ts';
import type { Queryable } from '../../database/connection.ts';
import { machines } from '../../database/schema.ts';
import { recordAudit } from '../audit/audit.ts';

/**
 * Verbose logging for a while (SPEC-AGENT-LOGS 1): the agent logs its own debug records until a
 * deadline of at most four hours. The server keeps the deadline, so it can send it again when the
 * agent reconnects; the agent forgets it when it restarts.
 */
export type VerboseRequest = { kind: 'for'; durationMs: number } | { kind: 'stop' };

export type VerboseResult =
	{ kind: 'not-found' } | { kind: 'set'; untilMs: number | null; delivered: boolean };

export function setVerbose(
	database: Queryable,
	machineId: string,
	actorUserId: string,
	request: VerboseRequest,
	send: (message: ServerSocketMessage) => boolean,
	now: number
): VerboseResult {
	const machine = database
		.select({ name: machines.name })
		.from(machines)
		.where(and(eq(machines.id, machineId), isNull(machines.removedAt)))
		.get();
	if (machine === undefined) {
		return { kind: 'not-found' };
	}
	const untilMs =
		request.kind === 'for' ? now + Math.min(Math.max(0, request.durationMs), MAX_VERBOSE_MS) : null;
	database
		.update(machines)
		.set({ verboseUntil: untilMs === null ? null : new Date(untilMs) })
		.where(eq(machines.id, machineId))
		.run();
	recordAudit(
		database,
		{
			actor: { kind: 'user', userId: actorUserId },
			kind: untilMs === null ? 'agent-verbose-stopped' : 'agent-verbose-started',
			target: machine.name,
			machineId,
			detail: untilMs === null ? {} : { until: new Date(untilMs).toISOString() }
		},
		now
	);
	const delivered = send(
		untilMs === null
			? { type: 'log-level', level: 'info' }
			: { type: 'log-level', level: 'debug', untilMs }
	);
	return { kind: 'set', untilMs, delivered };
}

/** Until when the machine is verbose, if it still is. */
export function verboseUntil(database: Queryable, machineId: string, now: number): number | null {
	const row = database
		.select({ until: machines.verboseUntil })
		.from(machines)
		.where(eq(machines.id, machineId))
		.get();
	const until = row?.until?.getTime() ?? null;
	return until !== null && until > now ? until : null;
}

/** On reconnect: the verbose setting again, while it lasts. */
export function verboseOnConnect(
	database: Queryable,
	machineId: string,
	now: number
): ServerSocketMessage | undefined {
	const until = verboseUntil(database, machineId, now);
	return until === null ? undefined : { type: 'log-level', level: 'debug', untilMs: until };
}
