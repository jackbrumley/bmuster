import { shellsFor } from '#lib/domain/machines/machine.ts';
import { endReasonLabel } from '#lib/domain/sessions/session.ts';
import type { ConsoleUser } from '#lib/domain/users/user.ts';
import type { OpenSessionReply, OpenSessionRequest } from '#lib/schemas/sessions/sessions.ts';
import type { AppDatabase } from '../../database/connection.ts';
import { permissionsFor } from '../access/access.ts';
import { isAgentConnected, sendToAgent } from '../agents/live-agents.ts';
import { serverKey } from '../agents/server-keys.ts';
import { recordAudit } from '../audit/audit.ts';
import { findMachine } from '../machines/machine-views.ts';
import type { EndedSession, Relay } from './relay.ts';
import { signTicket, TICKET_LIFETIME_MS } from './session-ticket.ts';

/**
 * Starting sessions (SPEC-SESSIONS T2, T3, T7). The server checks access
 * here; the agent checks the signed ticket again (AGENTS.md §11, check twice).
 */

/** Running sessions one person may have open at once, across machines. */
const MAX_SESSIONS_PER_PERSON = 10;

export type OpenSessionResult =
	| { kind: 'opened'; reply: OpenSessionReply }
	| { kind: 'refused'; status: 400 | 403 | 404 | 409; message: string };

/** Says who ran it as: the only choice for now is the agent's own account. */
const RUN_AS_LABEL = 'Administrator (root or SYSTEM)';

export function openTerminalSession(
	database: AppDatabase,
	relay: Relay,
	secretsKey: Buffer,
	user: ConsoleUser,
	machineId: string,
	request: OpenSessionRequest,
	ip: string,
	now: number
): OpenSessionResult {
	const grants = permissionsFor(database, user, machineId);
	const machine = findMachine(database, machineId, now);
	if (machine === undefined || !grants.some((grant) => grant.permission === 'view')) {
		return { kind: 'refused', status: 404, message: 'No machine with this id.' };
	}
	if (!grants.some((grant) => grant.permission === 'terminal')) {
		return {
			kind: 'refused',
			status: 403,
			message: "You don't have permission to open a terminal on this machine."
		};
	}
	if (!shellsFor(machine.osFamily).some((shell) => shell.id === request.shell)) {
		return {
			kind: 'refused',
			status: 400,
			message: `${request.shell} is not offered on this machine.`
		};
	}
	if (!isAgentConnected(machineId)) {
		return { kind: 'refused', status: 409, message: 'This machine is offline.' };
	}
	if (relay.countFor(user.id) >= MAX_SESSIONS_PER_PERSON) {
		return {
			kind: 'refused',
			status: 409,
			message: `You already have ${MAX_SESSIONS_PER_PERSON} sessions open. End one first.`
		};
	}

	const sessionId = crypto.randomUUID();
	const key = serverKey(database, secretsKey, now);
	const signed = signTicket(
		{
			sessionId,
			machineId,
			user: { id: user.id, name: user.name },
			permissions: grants.map((grant) => grant.permission),
			runAs: { kind: 'admin' },
			issuedAtMs: now,
			expiresAtMs: now + TICKET_LIFETIME_MS,
			purpose: { kind: 'terminal', shell: request.shell, cols: request.cols, rows: request.rows }
		},
		key.privateKey
	);
	relay.start(
		{
			id: sessionId,
			machineId,
			userId: user.id,
			userName: user.name,
			kind: 'terminal',
			shell: request.shell,
			ip,
			openedAt: now
		},
		(ended) => {
			auditEnded(database, ended, machine.name);
		}
	);
	recordAudit(
		database,
		{
			actor: { kind: 'user', userId: user.id },
			kind: 'session-opened',
			target: machine.name,
			machineId,
			detail: { type: 'terminal', shell: request.shell, 'run as': RUN_AS_LABEL, from: ip }
		},
		now
	);
	if (!sendToAgent(machineId, { type: 'session-open', ...signed })) {
		relay.end(sessionId, 'agent-lost', 'This machine is offline.');
		return { kind: 'refused', status: 409, message: 'This machine is offline.' };
	}
	const browserTicket = relay.issueBrowserTicket(sessionId, user.id);
	if (browserTicket === undefined) {
		throw new Error(`Session ${sessionId} ended before its first browser ticket`);
	}
	return { kind: 'opened', reply: { sessionId, browserTicket } };
}

export type BrowserTicketResult =
	{ kind: 'issued'; browserTicket: string } | { kind: 'ended'; message: string };

/** A fresh browser ticket for this person's own running session (a reload reattaches). */
export function browserTicketFor(
	relay: Relay,
	user: ConsoleUser,
	sessionId: string
): BrowserTicketResult {
	const browserTicket = relay.issueBrowserTicket(sessionId, user.id);
	if (browserTicket !== undefined) {
		return { kind: 'issued', browserTicket };
	}
	const ended = relay.endedSession(sessionId);
	return {
		kind: 'ended',
		message: ended?.userId === user.id ? ended.message : 'This session has ended.'
	};
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

/** T7: who, where, how long, how it ended, and how much went each way. Never the content. */
function auditEnded(database: AppDatabase, ended: EndedSession, machineName: string): void {
	recordAudit(
		database,
		{
			actor: { kind: 'user', userId: ended.userId },
			kind: 'session-ended',
			target: machineName,
			machineId: ended.machineId,
			detail: {
				type: 'terminal',
				shell: ended.shell,
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
