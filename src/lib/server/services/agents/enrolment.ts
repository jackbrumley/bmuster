import { eq } from 'drizzle-orm';
import type { EnrolReply, EnrolRequest } from '#lib/schemas/agents/agent-protocol.ts';
import {
	machineInventory,
	machineLocalPages,
	machineStatus,
	machines
} from '../../database/schema.ts';
import type { AppDatabase, Queryable } from '../../database/connection.ts';
import { joinGroupsAtEnrolment } from '../access/groups.ts';
import { recordAudit } from '../audit/audit.ts';
import { isRefusal, type AgentRefusal } from './agent-refusal.ts';
import { redeemJoinCode, type RedeemedCode } from './join-codes.ts';
import { disconnectAgent } from './live-agents.ts';

const DEFAULT_CHECK_IN_SECONDS = 60;

/**
 * Enrols a machine with a join code (SPEC-ENROLMENT 4 and 6). A reinstall
 * code (SPEC-MACHINE-DETAILS D9) takes over its machine's entry instead of
 * making a new one.
 */
export function enrolMachine(
	database: AppDatabase,
	request: EnrolRequest,
	serverPublicKey: string,
	now: number
): EnrolReply | AgentRefusal {
	const result = database.transaction((tx) => {
		const redeemed = redeemJoinCode(tx, request.code, now);
		if (isRefusal(redeemed)) {
			return redeemed;
		}
		switch (redeemed.purpose.kind) {
			case 'new-machine':
				return { machineId: enrolNew(tx, request, redeemed, now), reinstalled: false };
			case 'reinstall':
				takeOver(tx, redeemed.purpose.machineId, request, redeemed.joinCodeId, now);
				return { machineId: redeemed.purpose.machineId, reinstalled: true };
		}
	});
	if (isRefusal(result)) {
		return result;
	}
	if (result.reinstalled) {
		// The old agent's live socket (if any) belongs to the replaced key: close it
		// as revoked so that copy stops; its signed requests now fail the key check.
		disconnectAgent(result.machineId, 4001, 'revoked');
	}
	return {
		machineId: result.machineId,
		serverPublicKey,
		checkInSeconds: DEFAULT_CHECK_IN_SECONDS
	};
}

function enrolNew(
	tx: Queryable,
	request: EnrolRequest,
	redeemed: RedeemedCode,
	now: number
): string {
	const machineId = crypto.randomUUID();
	tx.insert(machines)
		.values({
			id: machineId,
			name: request.name,
			hostname: request.hostname,
			osFamily: request.osFamily,
			target: request.target,
			agentVersion: request.agentVersion,
			publicKey: request.publicKey,
			lastRequestMs: 0,
			checkInSeconds: DEFAULT_CHECK_IN_SECONDS,
			enrolledAt: new Date(now),
			lastSeenAt: new Date(now),
			joinCodeId: redeemed.joinCodeId
		})
		.run();
	const groups = joinGroupsAtEnrolment(tx, machineId, redeemed.machineGroupIds);
	recordAudit(
		tx,
		{
			actor: { kind: 'system' },
			kind: 'machine-enrolled',
			target: request.name,
			machineId,
			detail: {
				hostname: request.hostname,
				system: `${request.osFamily} (${request.target})`,
				code: redeemed.maxUses === 1 ? 'single use' : 'roll-out',
				groups: groups.length === 0 ? 'none' : groups.join(', ')
			}
		},
		now
	);
	return machineId;
}

/**
 * The new agent takes over the machine's entry: same id, name, description,
 * notes and history, with the new key, so the old key is refused from now on.
 * Status, inventory and the local page are cleared so the page waits for the
 * new agent's first check-in rather than showing the old install's figures.
 */
function takeOver(
	tx: Queryable,
	machineId: string,
	request: EnrolRequest,
	joinCodeId: string,
	now: number
): void {
	const machine = tx
		.select({ name: machines.name })
		.from(machines)
		.where(eq(machines.id, machineId))
		.get();
	if (machine === undefined) {
		// redeemJoinCode checked it inside this same transaction.
		throw new Error(`Reinstall target ${machineId} vanished during enrolment`);
	}
	tx.update(machines)
		.set({
			hostname: request.hostname,
			osFamily: request.osFamily,
			target: request.target,
			agentVersion: request.agentVersion,
			publicKey: request.publicKey,
			lastRequestMs: 0,
			enrolledAt: new Date(now),
			lastSeenAt: new Date(now),
			joinCodeId,
			// The new agent says at its first check-in which codes it takes, and numbers its
			// local page events afresh (SPEC-AGENT-LOCAL 7).
			localCodes: 'shared',
			localEventsSeq: 0
		})
		.where(eq(machines.id, machineId))
		.run();
	tx.delete(machineStatus).where(eq(machineStatus.machineId, machineId)).run();
	tx.delete(machineInventory).where(eq(machineInventory.machineId, machineId)).run();
	// The new agent makes its own local page secret and certificate.
	tx.delete(machineLocalPages).where(eq(machineLocalPages.machineId, machineId)).run();
	recordAudit(
		tx,
		{
			actor: { kind: 'system' },
			kind: 'machine-reinstalled',
			target: machine.name,
			machineId,
			detail: {
				hostname: request.hostname,
				system: `${request.osFamily} (${request.target})`
			}
		},
		now
	);
}
