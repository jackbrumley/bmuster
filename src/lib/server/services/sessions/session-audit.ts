import { endReasonLabel } from '#lib/domain/sessions/session.ts';
import type { AppDatabase } from '../../database/connection.ts';
import { listAuditOfKinds, recordAudit } from '../audit/audit.ts';
import type { ClipboardTransfer, EndedSession, SessionRecord } from './relay.ts';

/**
 * Audit entries for every session kind (SPEC-SESSIONS T7, SPEC-FILES F8,
 * SPEC-DESKTOP 9): who, where, how long, how it ended, and how much went
 * each way. Never the content: no screen, keystrokes or file data.
 */

/** Says who ran it as: the only choice for now is the agent's own account. */
const RUN_AS_LABEL = 'Administrator (root or SYSTEM)';

/**
 * "terminal" with its shell, "files", or "desktop" with its mode, and the session id, which joins
 * the entry to the agent's timeline of the same session (SPEC-DIAGNOSTICS 3).
 */
function typeDetail(record: SessionRecord): Record<string, string> {
	return { ...kindDetail(record), session: record.id };
}

function kindDetail(record: SessionRecord): Record<string, string> {
	switch (record.kind) {
		case 'terminal':
			return { type: 'terminal', shell: record.shell, 'run as': RUN_AS_LABEL };
		case 'files':
			return { type: 'files', 'run as': RUN_AS_LABEL };
		case 'desktop':
			// Ask sessions are refused until consent prompts exist (SPEC-DESKTOP 13).
			return { type: 'desktop', mode: record.mode, consent: 'unattended', codec: 'JPEG tiles' };
	}
}

export function auditSessionOpened(
	database: AppDatabase,
	record: SessionRecord,
	machineName: string
): void {
	recordAudit(
		database,
		{
			actor: { kind: 'user', userId: record.userId },
			kind: 'session-opened',
			target: machineName,
			machineId: record.machineId,
			detail: { ...typeDetail(record), from: record.ip }
		},
		record.openedAt
	);
}

/** One whole number of seconds, minutes and so on: "4 min 12 s". */
function durationText(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const rest = seconds % 60;
	if (hours > 0) {
		return `${hours} h ${minutes} min`;
	}
	return minutes > 0 ? `${minutes} min ${rest} s` : `${rest} s`;
}

export function auditSessionEnded(
	database: AppDatabase,
	ended: EndedSession,
	machineName: string
): void {
	recordAudit(
		database,
		{
			actor: { kind: 'user', userId: ended.userId },
			kind: 'session-ended',
			target: machineName,
			machineId: ended.machineId,
			detail: {
				...typeDetail(ended),
				from: ended.ip,
				duration: durationText(ended.endedAt - ended.openedAt),
				ended: endReasonLabel(ended.reason),
				'bytes in': String(ended.bytesIn),
				'bytes out': String(ended.bytesOut)
			}
		},
		ended.endedAt
	);
	if (ended.reason === 'disconnected-at-machine') {
		recordAudit(
			database,
			{
				actor: { kind: 'system' },
				kind: 'session-disconnected-at-machine',
				target: machineName,
				machineId: ended.machineId,
				detail: { viewer: ended.userName, mode: ended.kind === 'desktop' ? ended.mode : ended.kind }
			},
			ended.endedAt
		);
	}
}

/**
 * One copy or paste on a desktop (SPEC-DESKTOP 20.6): which way and how many bytes, never the
 * text or a hash of it, which for a short secret could be reversed by trying candidates.
 */
export function auditDesktopClipboard(
	database: AppDatabase,
	record: SessionRecord,
	machineName: string,
	transfer: ClipboardTransfer
): void {
	recordAudit(
		database,
		{
			actor: { kind: 'user', userId: record.userId },
			kind: 'desktop-clipboard',
			target: machineName,
			machineId: record.machineId,
			detail: {
				direction: transfer.direction === 'to-machine' ? 'to the machine' : 'from the machine',
				bytes: String(transfer.bytes),
				session: record.id
			}
		},
		transfer.at
	);
}

/** How far back a session left open is looked for, and how many entries one start reads. */
const OPEN_SESSION_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;
const OPEN_SESSION_SCAN_LIMIT = 20_000;

/**
 * Sessions live in the server's memory (relay.ts), so a server that stops (an update, a restart,
 * a crash) takes its open sessions with it and never writes their end. At start, every opened
 * session with no end is given one, "The server restarted", dated now; the real end time and
 * byte counts are not known, so the entry says so instead of guessing (SPEC-SESSIONS T9).
 * A session the relay still holds is running (the dev server reloads its hooks without stopping),
 * and entries from before 0.4.3 carry no session id; both are skipped. Returns how many were closed.
 */
export function closeSessionsCutByRestart(
	database: AppDatabase,
	isRunning: (sessionId: string) => boolean,
	now: number
): number {
	const entries = listAuditOfKinds(database, {
		kinds: ['session-opened', 'session-ended'],
		sinceMs: now - OPEN_SESSION_LOOKBACK_MS,
		limit: OPEN_SESSION_SCAN_LIMIT
	});
	const ended = new Set(
		entries
			.filter((entry) => entry.kind === 'session-ended')
			.map((entry) => entry.detail['session'])
	);
	let closed = 0;
	for (const opened of entries) {
		const sessionId = opened.detail['session'];
		if (
			opened.kind !== 'session-opened' ||
			sessionId === undefined ||
			ended.has(sessionId) ||
			isRunning(sessionId)
		) {
			continue;
		}
		const { from, ...kind } = opened.detail;
		recordAudit(
			database,
			{
				actor:
					opened.actorUserId === null
						? { kind: 'system' }
						: { kind: 'user', userId: opened.actorUserId },
				kind: 'session-ended',
				target: opened.target,
				machineId: opened.machineId,
				detail: {
					...kind,
					...(from === undefined ? {} : { from }),
					duration: 'unknown',
					ended: endReasonLabel('server-restarted')
				}
			},
			now
		);
		ended.add(sessionId);
		closed += 1;
	}
	return closed;
}
