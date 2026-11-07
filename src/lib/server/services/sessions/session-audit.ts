import { endReasonLabel } from '#lib/domain/sessions/session.ts';
import type { AppDatabase } from '../../database/connection.ts';
import { recordAudit } from '../audit/audit.ts';
import type { EndedSession, SessionRecord } from './relay.ts';

/**
 * Audit entries for every session kind (SPEC-SESSIONS T7, SPEC-FILES F8):
 * who, where, how long, how it ended, and how much went each way. Never
 * the content.
 */

/** Says who ran it as: the only choice for now is the agent's own account. */
const RUN_AS_LABEL = 'Administrator (root or SYSTEM)';

/** "terminal" with its shell, or "files". */
function typeDetail(record: SessionRecord): Record<string, string> {
	switch (record.kind) {
		case 'terminal':
			return { type: 'terminal', shell: record.shell };
		case 'files':
			return { type: 'files' };
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
			detail: { ...typeDetail(record), 'run as': RUN_AS_LABEL, from: record.ip }
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
				'run as': RUN_AS_LABEL,
				from: ended.ip,
				duration: durationText(ended.endedAt - ended.openedAt),
				ended: endReasonLabel(ended.reason),
				'bytes in': String(ended.bytesIn),
				'bytes out': String(ended.bytesOut)
			}
		},
		ended.endedAt
	);
}
