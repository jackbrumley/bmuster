import { shellsFor } from '#lib/domain/machines/machine.ts';
import type { ConsoleUser } from '#lib/domain/users/user.ts';
import type {
	BrowserTicketReply,
	OpenSessionReply,
	OpenSessionRequest
} from '#lib/schemas/sessions/sessions.ts';
import type { AppDatabase } from '../../database/connection.ts';
import { permissionsFor } from '../access/access.ts';
import { isAgentConnected, sendToAgent } from '../agents/live-agents.ts';
import { serverKey } from '../agents/server-keys.ts';
import { activeMachineBasics } from '../machines/machine-views.ts';
import type { Relay, SessionRecord } from './relay.ts';
import { auditSessionEnded, auditSessionOpened } from './session-audit.ts';
import { signTicket, TICKET_LIFETIME_MS } from './session-ticket.ts';

/**
 * Starting sessions (SPEC-SESSIONS T2, T3, T7). The server checks access
 * here; the agent checks the signed ticket again (AGENTS.md §11, check twice).
 */

/** Running sessions one person may have open at once, across machines. */
export const MAX_SESSIONS_PER_PERSON = 10;

export type OpenSessionResult =
	| { kind: 'opened'; reply: OpenSessionReply }
	| { kind: 'refused'; status: 400 | 403 | 404 | 409; message: string };

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
	const machine = activeMachineBasics(database, machineId);
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
	const record: SessionRecord = {
		id: sessionId,
		machineId,
		userId: user.id,
		userName: user.name,
		kind: 'terminal',
		shell: request.shell,
		ip,
		openedAt: now
	};
	relay.start(record, (ended) => {
		auditSessionEnded(database, ended, machine.name);
	});
	auditSessionOpened(database, record, machine.name);
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

/** A fresh browser ticket for this person's own running session (a reload reattaches). */
export function browserTicketFor(
	relay: Relay,
	user: ConsoleUser,
	sessionId: string
): BrowserTicketReply {
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
