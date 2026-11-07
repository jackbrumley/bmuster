import { eq } from 'drizzle-orm';
import type { AuditKind } from '#lib/domain/activity/activity.ts';
import { whoseCode } from '#lib/domain/activity/local-page-activity.ts';
import type {
	CodeOwners,
	LocalEvent,
	LocalEventsReport
} from '#lib/schemas/agents/agent-protocol.ts';
import { machines } from '../../database/schema.ts';
import type { AppDatabase } from '../../database/connection.ts';
import { recordAudit } from '../audit/audit.ts';
import { userNames } from '../users/users.ts';
import type { AuthenticatedAgent } from './agent-auth.ts';

/**
 * Local page events from the agent (SPEC-AGENT-LOCAL 7), each recorded in Activity as an entry
 * about the machine, actor System, at the time it happened. The agent's clock is corrected by
 * the gap between when it says it sent the report and when it arrived. Events at or below the
 * highest sequence number already taken are resends after a lost reply and are skipped.
 */

function auditKind(event: LocalEvent): AuditKind {
	switch (event.kind) {
		case 'signed-in':
			return 'local-signed-in';
		case 'signed-out':
			return 'local-signed-out';
		case 'session-expired':
			return 'local-session-expired';
		case 'wrong-code':
			return 'local-wrong-code';
		case 'locked-out':
			return 'local-locked-out';
		case 'restarted':
			return 'local-restarted';
		case 'connection-tested':
			return 'local-connection-tested';
		case 'move-started':
			return 'local-move-started';
		case 'move-finished':
			return 'local-move-finished';
		case 'move-failed':
			return 'local-move-failed';
		case 'leaving':
			return 'local-leaving';
		case 'uninstalled':
			return 'local-uninstalled';
		case 'dropped':
			return 'local-events-dropped';
	}
}

/** Whose code, by the names the server has now (the agent's copy if someone was deleted). */
function codesDetail(codes: CodeOwners, names: Map<string, string>): Record<string, string> {
	switch (codes.kind) {
		case 'machine':
			return { whose: whoseCode({ kind: 'machine' }) };
		case 'people':
			return {
				whose: whoseCode({
					kind: 'people',
					names: codes.people.map((person) => names.get(person.userId) ?? person.name)
				}),
				userIds: codes.people.map((person) => person.userId).join(' ')
			};
	}
}

function eventDetail(event: LocalEvent, names: Map<string, string>): Record<string, string> {
	switch (event.kind) {
		case 'wrong-code':
		case 'locked-out':
			return {};
		case 'dropped':
			return { count: String(event.count) };
		case 'signed-in':
		case 'signed-out':
		case 'session-expired':
		case 'restarted':
		case 'uninstalled':
			return codesDetail(event.codes, names);
		case 'connection-tested':
			return { ...codesDetail(event.codes, names), passed: event.passed ? 'yes' : 'no' };
		case 'move-started':
		case 'move-finished':
			return { ...codesDetail(event.codes, names), server: event.serverUrl };
		case 'move-failed':
			return { ...codesDetail(event.codes, names), reason: event.reason };
		case 'leaving':
			return { ...codesDetail(event.codes, names), reason: event.reason };
	}
}

function peopleIn(event: LocalEvent): string[] {
	return 'codes' in event && event.codes.kind === 'people'
		? event.codes.people.map((person) => person.userId)
		: [];
}

/** Records the events not seen before; returns how many. */
export function recordLocalEvents(
	database: AppDatabase,
	agent: AuthenticatedAgent,
	report: LocalEventsReport,
	now: number
): number {
	const clockGap = now - report.sentAtMs;
	return database.transaction((tx) => {
		const machine = tx
			.select({ name: machines.name, seq: machines.localEventsSeq })
			.from(machines)
			.where(eq(machines.id, agent.machineId))
			.get();
		if (machine === undefined) {
			// The signature check found it inside this request.
			throw new Error(`Machine ${agent.machineId} vanished while recording local events`);
		}
		const fresh = report.events
			.filter((entry) => entry.seq > machine.seq)
			.toSorted((a, b) => a.seq - b.seq);
		const last = fresh.at(-1);
		if (last === undefined) {
			return 0;
		}
		const names = userNames(tx, [...new Set(fresh.flatMap((entry) => peopleIn(entry.event)))]);
		const sentIso = new Date(now).toISOString();
		for (const entry of fresh) {
			recordAudit(
				tx,
				{
					actor: { kind: 'system' },
					kind: auditKind(entry.event),
					target: machine.name,
					machineId: agent.machineId,
					detail: { ...eventDetail(entry.event, names), sentIso }
				},
				Math.min(entry.atMs + clockGap, now)
			);
		}
		tx.update(machines)
			.set({ localEventsSeq: last.seq })
			.where(eq(machines.id, agent.machineId))
			.run();
		return fresh.length;
	});
}
