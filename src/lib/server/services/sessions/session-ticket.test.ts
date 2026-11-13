import { createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { signTicket, type SessionTicket } from './session-ticket.ts';

// SPEC-SESSIONS T3: the shared vectors in agent/crates/protocol, byte for byte.
type Vectors = {
	seedHex: string;
	publicKeyBase64: string;
	machineId: string;
	nowMs: number;
	tickets: {
		ticket: SessionTicket;
		ticketJson: string;
		ticketBase64: string;
		signatureBase64: string;
	}[];
};

const vectors = JSON.parse(
	readFileSync('agent/crates/protocol/tests/ticket-vectors.json', 'utf8')
) as Vectors;

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const privateKey = createPrivateKey({
	key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(vectors.seedHex, 'hex')]),
	format: 'der',
	type: 'pkcs8'
});

describe('session tickets (T3)', () => {
	it('has vectors for every purpose the agent knows', () => {
		expect(vectors.tickets.map((vector) => vector.ticket.purpose.kind)).toEqual([
			'terminal',
			'exec',
			'files',
			'desktop'
		]);
	});

	for (const vector of vectors.tickets) {
		it(`signs a ${vector.ticket.purpose.kind} ticket exactly as the agent checks it`, () => {
			const signed = signTicket(vector.ticket, privateKey);
			expect(Buffer.from(signed.ticket, 'base64').toString('utf8')).toBe(vector.ticketJson);
			expect(signed.ticket).toBe(vector.ticketBase64);
			expect(signed.signature).toBe(vector.signatureBase64);
		});
	}

	it('C13: the exec vector carries run-commands, the exact command and the 2 MB cap the agent checks', () => {
		const exec = vectors.tickets.find((vector) => vector.ticket.purpose.kind === 'exec');
		if (exec === undefined) throw new Error('no exec vector');
		expect(exec.ticket.permissions).toEqual(['view', 'run-commands']);
		expect(exec.ticket.purpose).toEqual({
			kind: 'exec',
			shell: 'powershell',
			command: 'Get-Service | Where-Object Status -eq "Running"',
			timeoutMs: 60_000,
			maxOutputBytes: 2 * 1024 * 1024
		});
		// Signed over the exact bytes: a changed command or machine fails the agent's check.
		const changed = signTicket(
			{
				...exec.ticket,
				purpose: {
					kind: 'exec',
					shell: 'powershell',
					command: 'shutdown /s',
					timeoutMs: 60_000,
					maxOutputBytes: 2 * 1024 * 1024
				}
			},
			privateKey
		);
		expect(changed.signature).not.toBe(exec.signatureBase64);
	});

	it('keeps the agreed field order whatever order the ticket was built in', () => {
		const vector = vectors.tickets[0];
		if (vector === undefined) throw new Error('no vectors');
		const { purpose, user, ...rest } = vector.ticket;
		const shuffled: SessionTicket = { purpose, ...rest, user };
		expect(signTicket(shuffled, privateKey).ticket).toBe(vector.ticketBase64);
	});
});
