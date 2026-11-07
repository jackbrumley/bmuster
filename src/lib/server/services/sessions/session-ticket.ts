import { sign, type KeyObject } from 'node:crypto';
import type { TerminalShell } from '#lib/domain/sessions/session.ts';

/**
 * Session tickets (SPEC-SESSIONS T3): what the server allows one session to
 * do, signed with the server's Ed25519 key. The agent checks the signature
 * against the key it learnt at enrolment, so a ticket cannot be forged or
 * changed on the way, even by someone who can reach the agent's socket.
 *
 * Must match agent/crates/protocol/src/session.rs byte for byte:
 * the shared vectors in agent/crates/protocol/tests/ticket-vectors.json
 * prove it. Field order is part of the format.
 */

/** First line of every signed ticket; the agent checks the same. */
const TICKET_DOMAIN = 'BMUSTER-TICKET-1';

/** How long the agent has to start the session. */
export const TICKET_LIFETIME_MS = 60_000;

type TicketPurpose =
	| { kind: 'terminal'; shell: TerminalShell; cols: number; rows: number }
	| {
			kind: 'exec';
			shell: TerminalShell;
			command: string;
			timeoutMs: number;
			maxOutputBytes: number;
	  };

export type SessionTicket = {
	sessionId: string;
	machineId: string;
	user: { id: string; name: string };
	/** The person's permissions on the machine; the agent requires the one the purpose needs. */
	permissions: string[];
	runAs: { kind: 'admin' };
	issuedAtMs: number;
	expiresAtMs: number;
	purpose: TicketPurpose;
};

export type SignedTicket = { ticket: string; signature: string };

/** The ticket as JSON, fields in the agreed order (so the vectors match). */
function ticketJson(ticket: SessionTicket): string {
	const purpose: TicketPurpose =
		ticket.purpose.kind === 'terminal'
			? {
					kind: 'terminal',
					shell: ticket.purpose.shell,
					cols: ticket.purpose.cols,
					rows: ticket.purpose.rows
				}
			: {
					kind: 'exec',
					shell: ticket.purpose.shell,
					command: ticket.purpose.command,
					timeoutMs: ticket.purpose.timeoutMs,
					maxOutputBytes: ticket.purpose.maxOutputBytes
				};
	return JSON.stringify({
		sessionId: ticket.sessionId,
		machineId: ticket.machineId,
		user: { id: ticket.user.id, name: ticket.user.name },
		permissions: ticket.permissions,
		runAs: { kind: ticket.runAs.kind },
		issuedAtMs: ticket.issuedAtMs,
		expiresAtMs: ticket.expiresAtMs,
		purpose
	});
}

/** Signs a ticket: base64 of its JSON, and of the signature over `BMUSTER-TICKET-1\n` + that JSON. */
export function signTicket(ticket: SessionTicket, privateKey: KeyObject): SignedTicket {
	const json = Buffer.from(ticketJson(ticket), 'utf8');
	const message = Buffer.concat([Buffer.from(`${TICKET_DOMAIN}\n`, 'utf8'), json]);
	return {
		ticket: json.toString('base64'),
		signature: sign(null, message, privateKey).toString('base64')
	};
}
