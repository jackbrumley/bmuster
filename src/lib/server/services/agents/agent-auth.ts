import { and, eq, lt } from 'drizzle-orm';
import { machines } from '../../database/schema.ts';
import type { AppDatabase } from '../../database/connection.ts';
import { refuse, type AgentRefusal } from './agent-refusal.ts';
import { parseAuthorization, requestMessage, verifySignature } from './signing.ts';

/** How far an agent's clock may be from the server's. */
const CLOCK_TOLERANCE_MS = 5 * 60_000;

export type AuthenticatedAgent = { machineId: string; checkInSeconds: number };

export type SignedRequest = {
	method: string;
	/** URL path only, no query string, exactly as the agent sent it. */
	path: string;
	authorization: string | null;
	body: Uint8Array;
};

/**
 * Checks a signed agent request (SPEC-ENROLMENT 6): the header parses, the
 * time is near ours, the machine's key signed exactly this request, and the
 * timestamp beats the last one accepted (so a captured request cannot be
 * replayed). On success the timestamp is claimed.
 */
export function authenticateAgent(
	database: AppDatabase,
	request: SignedRequest,
	now: number
): AuthenticatedAgent | AgentRefusal {
	const auth = parseAuthorization(request.authorization);
	if (auth === undefined) {
		return refuse(
			'bad-signature',
			"Expected 'Authorization: BMuster <machineId>:<timestampMs>:<signature>'."
		);
	}
	if (Math.abs(now - auth.timestampMs) > CLOCK_TOLERANCE_MS) {
		return refuse(
			'stale-timestamp',
			"The request's time is more than 5 minutes from the server's."
		);
	}
	const machine = database.select().from(machines).where(eq(machines.id, auth.machineId)).get();
	if (machine === undefined) {
		return refuse('unknown-machine', 'This machine is not enrolled on this server.');
	}
	const message = requestMessage(request.method, request.path, auth.timestampMs, request.body);
	if (!verifySignature(machine.publicKey, message, auth.signature)) {
		return refuse('bad-signature', "The signature does not match this machine's key.");
	}
	if (machine.removedAt !== null) {
		return refuse('revoked', 'This machine was removed from the server.');
	}
	const claimed = database
		.update(machines)
		.set({ lastRequestMs: auth.timestampMs })
		.where(and(eq(machines.id, machine.id), lt(machines.lastRequestMs, auth.timestampMs)))
		.run();
	if (claimed.changes !== 1) {
		return refuse('replayed-timestamp', 'This request time was already used.');
	}
	return { machineId: machine.id, checkInSeconds: machine.checkInSeconds };
}
