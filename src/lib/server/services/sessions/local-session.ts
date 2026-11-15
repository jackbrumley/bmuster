import type { ConsoleUser } from '#lib/domain/users/user.ts';
import type { AppDatabase } from '../../database/connection.ts';
import { sendToAgent } from '../agents/live-agents.ts';
import { serverKey } from '../agents/server-keys.ts';
import type { OpenSession } from './files-channel.ts';
import type { Relay } from './relay.ts';
import type { SessionRecord } from './session-record.ts';
import { auditSessionEnded, auditSessionOpened } from './session-audit.ts';
import { signTicket, TICKET_LIFETIME_MS, type TicketPurpose } from './session-ticket.ts';
import { MAX_SESSIONS_PER_PERSON } from './sessions.ts';

/**
 * Opens a session whose other end is the server itself (SPEC-FILES, SPEC-SESSION-FILES):
 * within the person's session limit, with a ticket signed for its purpose, audited when it
 * opens and ends, and asked of the agent on its live socket.
 */
export function localSessionOpener(
	context: {
		database: AppDatabase;
		relay: Relay;
		secretsKey: Buffer;
		user: ConsoleUser;
		machineId: string;
		ip: string;
		now: number;
	},
	terms: {
		machineName: string;
		permissions: string[];
		purpose: TicketPurpose;
		kind: { kind: 'files' } | { kind: 'session-files'; desktopSessionId: string };
	}
): OpenSession {
	const { database, relay, secretsKey, user, machineId, ip, now } = context;
	return (local, onEnded) => {
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
				permissions: terms.permissions,
				runAs: { kind: 'admin' },
				issuedAtMs: now,
				expiresAtMs: now + TICKET_LIFETIME_MS,
				purpose: terms.purpose
			},
			key.privateKey
		);
		const record: SessionRecord = {
			id: sessionId,
			machineId,
			userId: user.id,
			userName: user.name,
			viewer: { kind: 'user' },
			...terms.kind,
			ip,
			openedAt: now
		};
		relay.startLocal(
			record,
			(ended) => {
				onEnded(ended);
				auditSessionEnded(database, ended, terms.machineName);
			},
			local
		);
		auditSessionOpened(database, record, terms.machineName);
		if (!sendToAgent(machineId, { type: 'session-open', ...signed })) {
			relay.end(sessionId, 'agent-lost', 'This machine is offline.');
			return { kind: 'refused', status: 503, message: 'This machine is offline.' };
		}
		return { kind: 'opened', sessionId };
	};
}
