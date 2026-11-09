import { eq } from 'drizzle-orm';
import {
	STATS_TARGET,
	TIMELINE_TARGET,
	type MachineSessionView,
	type SessionStatsView,
	type SessionTimelineView
} from '#lib/domain/logs/checks.ts';
import { statsTextSchema, timelineTextSchema } from '#lib/schemas/logs/checks.ts';
import type { Queryable } from '../../database/connection.ts';
import { machines } from '../../database/schema.ts';
import { listMachineAudit, recordAudit, type AuditRecord } from '../audit/audit.ts';
import { userNames } from '../users/users.ts';
import type { Reader } from './diagnostics-reads.ts';
import { readTargetRecords } from './log-queries.ts';

/**
 * A machine's sessions with their timelines (SPEC-DIAGNOSTICS 3): the server's own session
 * entries (who, when, how it ended) joined by session id to the timeline and desktop figures the
 * agent shipped as ordinary log records. Reads are audited with the count, never the contents.
 */

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** Bounds on what one read scans. */
const MAX_ENTRIES = 2000;
const MAX_RECORDS = 5000;
const STATS_PER_SESSION = 10;

type Building = {
	sessionId: string;
	opened: AuditRecord | undefined;
	ended: AuditRecord | undefined;
	timeline: SessionTimelineView | undefined;
	timelineKind: string | undefined;
	stats: SessionStatsView[];
};

function building(all: Map<string, Building>, sessionId: string): Building {
	const found = all.get(sessionId);
	if (found !== undefined) return found;
	const made: Building = {
		sessionId,
		opened: undefined,
		ended: undefined,
		timeline: undefined,
		timelineKind: undefined,
		stats: []
	};
	all.set(sessionId, made);
	return made;
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function gather(database: Queryable, machineId: string, sinceMs: number): Map<string, Building> {
	const all = new Map<string, Building>();
	for (const entry of listMachineAudit(database, {
		machineId,
		kinds: ['session-opened', 'session-ended'],
		sinceMs,
		limit: MAX_ENTRIES
	})) {
		const sessionId = entry.detail['session'];
		// Entries from before 0.4.3 carry no session id and cannot be joined.
		if (sessionId === undefined) continue;
		const session = building(all, sessionId);
		if (entry.kind === 'session-opened') session.opened = entry;
		else session.ended = entry;
	}
	// Newest first: the first timeline of a session is its latest.
	for (const record of readTargetRecords(database, {
		machineId,
		targets: [TIMELINE_TARGET, STATS_TARGET],
		sinceMs,
		limit: MAX_RECORDS
	})) {
		const json = parseJson(record.text);
		if (record.target === TIMELINE_TARGET) {
			const timeline = timelineTextSchema.safeParse(json);
			if (!timeline.success) continue;
			const session = building(all, timeline.data.sessionId);
			if (session.timeline !== undefined) continue;
			session.timelineKind = timeline.data.kind;
			session.timeline = {
				outcome: timeline.data.outcome,
				reason: timeline.data.reason,
				startedIso: new Date(timeline.data.startedAt).toISOString(),
				steps: timeline.data.steps,
				omitted: timeline.data.omitted
			};
		} else {
			const stats = statsTextSchema.safeParse(json);
			if (!stats.success) continue;
			const session = building(all, stats.data.sessionId);
			if (session.stats.length >= STATS_PER_SESSION) continue;
			session.stats.push({
				atIso: record.at.toISOString(),
				intervalMs: stats.data.intervalMs,
				framesSent: stats.data.framesSent,
				captureMsAvg: stats.data.captureMsAvg,
				encodeMsAvg: stats.data.encodeMsAvg,
				bytesPerSecond: stats.data.bytesPerSecond,
				droppedFrames: stats.data.droppedFrames,
				tiles: stats.data.tiles,
				backend: stats.data.backend
			});
		}
	}
	return all;
}

function view(session: Building, names: Map<string, string>): MachineSessionView {
	const { opened, ended, timeline } = session;
	const startedIso =
		opened?.at.toISOString() ??
		timeline?.startedIso ??
		session.stats.at(-1)?.atIso ??
		new Date(0).toISOString();
	return {
		sessionId: session.sessionId,
		kind: opened?.detail['type'] ?? session.timelineKind ?? 'desktop',
		startedIso,
		server:
			opened === undefined
				? { kind: 'unknown' }
				: {
						kind: 'known',
						userName:
							opened.actorUserId === null
								? 'Unknown'
								: (names.get(opened.actorUserId) ?? 'Unknown'),
						openedIso: opened.at.toISOString(),
						ended:
							ended === undefined
								? { kind: 'running' }
								: {
										kind: 'ended',
										endedIso: ended.at.toISOString(),
										how: ended.detail['ended'] ?? ''
									}
					},
		timeline: timeline === undefined ? { kind: 'none' } : { kind: 'shipped', ...timeline },
		stats: session.stats
	};
}

/** The machine's newest sessions since `since` (default a week), or undefined for no machine. */
export function readMachineSessions(
	database: Queryable,
	reader: Reader,
	machineId: string,
	filter: { since: string | null; limit: number },
	now: number
): MachineSessionView[] | undefined {
	const machine = database
		.select({ name: machines.name })
		.from(machines)
		.where(eq(machines.id, machineId))
		.get();
	if (machine === undefined) {
		return undefined;
	}
	const sinceMs = filter.since === null ? now - WEEK_MS : Date.parse(filter.since);
	const gathered = [...gather(database, machineId, sinceMs).values()];
	const names = userNames(
		database,
		gathered.flatMap((session) =>
			session.opened?.actorUserId === undefined || session.opened.actorUserId === null
				? []
				: [session.opened.actorUserId]
		)
	);
	const sessions = gathered
		.map((session) => view(session, names))
		.sort((a, b) => b.startedIso.localeCompare(a.startedIso))
		.slice(0, filter.limit);
	recordAudit(
		database,
		{
			actor: { kind: 'user', userId: reader.userId },
			kind: 'agent-sessions-viewed',
			target: machine.name,
			machineId,
			detail: {
				since: new Date(sinceMs).toISOString(),
				sessions: String(sessions.length),
				via: reader.via
			}
		},
		now
	);
	return sessions;
}
