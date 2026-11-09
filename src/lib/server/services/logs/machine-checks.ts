import { and, eq, isNull } from 'drizzle-orm';
import { RUN_CHECKS_EVERY_MS, type MachineChecks } from '#lib/domain/logs/checks.ts';
import type { ServerSocketMessage } from '#lib/schemas/agents/agent-protocol.ts';
import {
	storedChecksSchema,
	type CheckResultWire,
	type ChecksReport
} from '#lib/schemas/logs/checks.ts';
import type { Queryable } from '../../database/connection.ts';
import { machineChecks, machines } from '../../database/schema.ts';
import { recordAudit } from '../audit/audit.ts';

/**
 * The agent's self-check results (SPEC-DIAGNOSTICS 1). The latest set replaces the last one,
 * whether it came in a check-in or on the live socket after Run checks. What the checks do is
 * fixed in the agent: `run-checks` carries nothing, so nobody can change them from here.
 */

function store(database: Queryable, machineId: string, results: string, now: number): void {
	const row = { results, checkedAt: new Date(now) };
	database
		.insert(machineChecks)
		.values({ machineId, ...row })
		.onConflictDoUpdate({ target: machineChecks.machineId, set: row })
		.run();
}

/** The check-in's `checks`. `pending` (just started) never hides results the server has. */
export function storeCheckInChecks(
	database: Queryable,
	machineId: string,
	report: ChecksReport,
	now: number
): void {
	switch (report.kind) {
		case 'unreported':
			return;
		case 'pending':
			database
				.insert(machineChecks)
				.values({ machineId, results: JSON.stringify(report), checkedAt: new Date(now) })
				.onConflictDoNothing()
				.run();
			return;
		case 'results':
			storeCheckResults(database, machineId, report.results, now);
			return;
	}
}

/** `checks` from the live socket, for the socket's own machine. */
export function storeCheckResults(
	database: Queryable,
	machineId: string,
	results: readonly CheckResultWire[],
	now: number
): void {
	store(database, machineId, JSON.stringify({ kind: 'results', results }), now);
}

/** The latest results, or undefined when there is no such machine. */
export function readMachineChecks(
	database: Queryable,
	machineId: string
): MachineChecks | undefined {
	const machine = database
		.select({ id: machines.id })
		.from(machines)
		.where(eq(machines.id, machineId))
		.get();
	if (machine === undefined) {
		return undefined;
	}
	const row = database
		.select()
		.from(machineChecks)
		.where(eq(machineChecks.machineId, machineId))
		.get();
	if (row === undefined) {
		return { kind: 'unreported' };
	}
	const stored = storedChecksSchema.parse(JSON.parse(row.results));
	const receivedIso = row.checkedAt.toISOString();
	switch (stored.kind) {
		case 'pending':
			return { kind: 'pending', receivedIso };
		case 'results':
			return {
				kind: 'results',
				receivedIso,
				results: stored.results.map((result) => ({
					id: result.id,
					title: result.title,
					status: result.status,
					detail: result.detail,
					durationMs: result.durationMs,
					checkedAtIso: new Date(result.checkedAt).toISOString()
				}))
			};
	}
}

export type RunChecksResult =
	| { kind: 'not-found' }
	| { kind: 'too-soon'; waitSeconds: number }
	| { kind: 'offline' }
	| { kind: 'requested' };

/** When each machine was last asked; in memory, so a restart allows one more at once. */
const lastAsked = new Map<string, number>();

/** Run checks (admins): at most once a minute per machine, audited, to a connected agent only. */
export function requestChecks(
	database: Queryable,
	machineId: string,
	actorUserId: string,
	send: (message: ServerSocketMessage) => boolean,
	now: number
): RunChecksResult {
	const machine = database
		.select({ name: machines.name })
		.from(machines)
		.where(and(eq(machines.id, machineId), isNull(machines.removedAt)))
		.get();
	if (machine === undefined) {
		return { kind: 'not-found' };
	}
	const last = lastAsked.get(machineId);
	if (last !== undefined && now - last < RUN_CHECKS_EVERY_MS) {
		return {
			kind: 'too-soon',
			waitSeconds: Math.ceil((RUN_CHECKS_EVERY_MS - (now - last)) / 1000)
		};
	}
	if (!send({ type: 'run-checks' })) {
		return { kind: 'offline' };
	}
	lastAsked.set(machineId, now);
	recordAudit(
		database,
		{
			actor: { kind: 'user', userId: actorUserId },
			kind: 'agent-checks-requested',
			target: machine.name,
			machineId,
			detail: {}
		},
		now
	);
	return { kind: 'requested' };
}

/** Tests: every machine may be asked again at once. */
export function resetCheckRequests(): void {
	lastAsked.clear();
}
