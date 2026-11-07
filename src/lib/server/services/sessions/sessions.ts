import type { Grant, Permission } from '#lib/domain/access/access.ts';
import { shellsFor, type OsFamily } from '#lib/domain/machines/machine.ts';
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
import { getSetting } from '../settings/settings.ts';
import type { Relay, SessionRecord } from './relay.ts';
import { auditSessionEnded, auditSessionOpened } from './session-audit.ts';
import { signTicket, TICKET_LIFETIME_MS, type TicketPurpose } from './session-ticket.ts';

/**
 * Starting sessions (SPEC-SESSIONS T2, T3, T7; SPEC-DESKTOP R2, R3). The server checks access
 * here; the agent checks the signed ticket again (AGENTS.md §11, check twice).
 */

/** Running sessions one person may have open at once, across machines. */
export const MAX_SESSIONS_PER_PERSON = 10;

export type OpenSessionResult =
	| { kind: 'opened'; reply: OpenSessionReply }
	| { kind: 'refused'; status: 400 | 403 | 404 | 409; message: string };

type TerminalRequest = Extract<OpenSessionRequest, { kind: 'terminal' }>;
type DesktopRequest = Extract<OpenSessionRequest, { kind: 'desktop' }>;

/** What the ticket carries besides the session, machine and person. */
type SessionTerms = { permissions: string[]; purpose: TicketPurpose };

/** The checks every session kind starts with: the machine is visible, online, and the person has room. */
function checkMachine(
	database: AppDatabase,
	relay: Relay,
	user: ConsoleUser,
	machineId: string
):
	| { kind: 'ok'; grants: Grant[]; machine: { name: string; osFamily: OsFamily } }
	| Extract<OpenSessionResult, { kind: 'refused' }> {
	const grants = permissionsFor(database, user, machineId);
	const machine = activeMachineBasics(database, machineId);
	if (machine === undefined || !grants.some((grant) => grant.permission === 'view')) {
		return { kind: 'refused', status: 404, message: 'No machine with this id.' };
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
	return { kind: 'ok', grants, machine };
}

/** Signs the ticket, starts the relay's session, audits it and asks the agent. */
function startSession(
	database: AppDatabase,
	relay: Relay,
	secretsKey: Buffer,
	record: SessionRecord,
	machineName: string,
	terms: SessionTerms,
	now: number
): OpenSessionResult {
	const key = serverKey(database, secretsKey, now);
	const signed = signTicket(
		{
			sessionId: record.id,
			machineId: record.machineId,
			user: { id: record.userId, name: record.userName },
			permissions: terms.permissions,
			runAs: { kind: 'admin' },
			issuedAtMs: now,
			expiresAtMs: now + TICKET_LIFETIME_MS,
			purpose: terms.purpose
		},
		key.privateKey
	);
	relay.start(record, (ended) => {
		auditSessionEnded(database, ended, machineName);
	});
	auditSessionOpened(database, record, machineName);
	if (!sendToAgent(record.machineId, { type: 'session-open', ...signed })) {
		relay.end(record.id, 'agent-lost', 'This machine is offline.');
		return { kind: 'refused', status: 409, message: 'This machine is offline.' };
	}
	const browserTicket = relay.issueBrowserTicket(record.id, record.userId);
	if (browserTicket === undefined) {
		throw new Error(`Session ${record.id} ended before its first browser ticket`);
	}
	return { kind: 'opened', reply: { sessionId: record.id, browserTicket } };
}

export function openTerminalSession(
	database: AppDatabase,
	relay: Relay,
	secretsKey: Buffer,
	user: ConsoleUser,
	machineId: string,
	request: TerminalRequest,
	ip: string,
	now: number
): OpenSessionResult {
	const checked = checkMachine(database, relay, user, machineId);
	if (checked.kind === 'refused') {
		return checked;
	}
	const { grants, machine } = checked;
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
	const record: SessionRecord = {
		id: crypto.randomUUID(),
		machineId,
		userId: user.id,
		userName: user.name,
		kind: 'terminal',
		shell: request.shell,
		ip,
		openedAt: now
	};
	return startSession(
		database,
		relay,
		secretsKey,
		record,
		machine.name,
		{
			permissions: grants.map((grant) => grant.permission),
			purpose: { kind: 'terminal', shell: request.shell, cols: request.cols, rows: request.rows }
		},
		now
	);
}

/**
 * Opens a desktop (SPEC-DESKTOP R2, R3, R12): `desktop-view` watches,
 * `desktop-control` controls, and a person who may control can still ask
 * to only watch. The ticket names exactly the desktop permissions this
 * session has. Sessions that would ask the person at the screen first are
 * refused until the consent prompt is built (phase 5), never connected
 * without asking.
 */
export function openDesktopSession(
	database: AppDatabase,
	relay: Relay,
	secretsKey: Buffer,
	user: ConsoleUser,
	machineId: string,
	request: DesktopRequest,
	ip: string,
	now: number
): OpenSessionResult {
	const checked = checkMachine(database, relay, user, machineId);
	if (checked.kind === 'refused') {
		return checked;
	}
	const { grants, machine } = checked;
	const needed: Permission = request.mode === 'control' ? 'desktop-control' : 'desktop-view';
	const grant = grants.find((candidate) => candidate.permission === needed);
	if (grant === undefined) {
		return {
			kind: 'refused',
			status: 403,
			message:
				request.mode === 'control'
					? "You don't have permission to control this machine's screen."
					: "You don't have permission to watch this machine's screen."
		};
	}
	if (grant.consent === 'ask') {
		return {
			kind: 'refused',
			status: 409,
			message:
				'Your access to this machine asks the person at the screen first, and BMuster cannot ask yet. Ask an admin to make the rule unattended, or wait for consent prompts.'
		};
	}
	const record: SessionRecord = {
		id: crypto.randomUUID(),
		machineId,
		userId: user.id,
		userName: user.name,
		kind: 'desktop',
		mode: request.mode,
		ip,
		openedAt: now
	};
	return startSession(
		database,
		relay,
		secretsKey,
		record,
		machine.name,
		{
			permissions:
				request.mode === 'control' ? ['desktop-view', 'desktop-control'] : ['desktop-view'],
			purpose: {
				kind: 'desktop',
				consent: grant.consent,
				notice: getSetting(database, 'connectedNotice')
			}
		},
		now
	);
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
