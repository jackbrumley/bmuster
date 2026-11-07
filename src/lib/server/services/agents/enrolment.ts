import type { EnrolReply, EnrolRequest } from '#lib/schemas/agents/agent-protocol.ts';
import { machines } from '../../database/schema.ts';
import type { AppDatabase } from '../../database/connection.ts';
import { recordAudit } from '../audit/audit.ts';
import { isRefusal, type AgentRefusal } from './agent-refusal.ts';
import { redeemJoinCode } from './join-codes.ts';

const DEFAULT_CHECK_IN_SECONDS = 60;

/** Enrols a machine with a join code (SPEC-ENROLMENT 4 and 6). */
export function enrolMachine(
	database: AppDatabase,
	request: EnrolRequest,
	serverPublicKey: string,
	now: number
): EnrolReply | AgentRefusal {
	return database.transaction((tx) => {
		const redeemed = redeemJoinCode(tx, request.code, now);
		if (isRefusal(redeemed)) {
			return redeemed;
		}
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
		recordAudit(
			tx,
			{
				actor: { kind: 'system' },
				kind: 'machine-enrolled',
				target: request.name,
				detail: {
					hostname: request.hostname,
					system: `${request.osFamily} (${request.target})`,
					code: redeemed.maxUses === 1 ? 'single use' : 'roll-out'
				}
			},
			now
		);
		// Machine groups arrive with the access model; redeemed.machineGroupIds is kept for then.
		return { machineId, serverPublicKey, checkInSeconds: DEFAULT_CHECK_IN_SECONDS };
	});
}
