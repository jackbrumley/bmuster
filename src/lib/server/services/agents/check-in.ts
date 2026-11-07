import { eq } from 'drizzle-orm';
import type { CheckInReply, CheckInRequest } from '#lib/schemas/agents/agent-protocol.ts';
import { machineInventory, machineStatus, machines } from '../../database/schema.ts';
import type { AppDatabase } from '../../database/connection.ts';
import type { AuthenticatedAgent } from './agent-auth.ts';
import { localCodesFrom, localUsersUpdate } from './local-users.ts';

/** Records a check-in (SPEC-ENROLMENT 7). */
export function recordCheckIn(
	database: AppDatabase,
	agent: AuthenticatedAgent,
	checkIn: CheckInRequest,
	now: number
): CheckInReply {
	const at = new Date(now);
	return database.transaction((tx) => {
		// The last user is kept when nobody is signed in (SPEC-MACHINE-DETAILS D7).
		const lastUser =
			checkIn.signedInUser.kind === 'user'
				? { lastUserName: checkIn.signedInUser.name, lastUserSeenAt: at }
				: {};
		const machine = tx
			.update(machines)
			.set({
				agentVersion: checkIn.agentVersion,
				lastSeenAt: at,
				localCodes: localCodesFrom(checkIn.localUsers),
				...lastUser
			})
			.where(eq(machines.id, agent.machineId))
			.returning({ name: machines.name })
			.get();

		const status = {
			signedInUser: JSON.stringify(checkIn.signedInUser),
			cpuPercent: checkIn.load.cpuPercent,
			memoryUsedBytes: checkIn.load.memoryUsedBytes,
			uptimeSeconds: checkIn.uptimeSeconds,
			updatedAt: at
		};
		tx.insert(machineStatus)
			.values({ machineId: agent.machineId, ...status })
			.onConflictDoUpdate({ target: machineStatus.machineId, set: status })
			.run();

		let inventoryWanted = false;
		switch (checkIn.inventory.kind) {
			case 'full': {
				const inventory = {
					hash: checkIn.inventory.hash,
					data: JSON.stringify(checkIn.inventory.data),
					updatedAt: at
				};
				tx.insert(machineInventory)
					.values({ machineId: agent.machineId, ...inventory })
					.onConflictDoUpdate({ target: machineInventory.machineId, set: inventory })
					.run();
				break;
			}
			case 'unchanged': {
				const stored = tx
					.select({ hash: machineInventory.hash })
					.from(machineInventory)
					.where(eq(machineInventory.machineId, agent.machineId))
					.get();
				inventoryWanted = stored?.hash !== checkIn.inventory.hash;
				break;
			}
		}
		return {
			checkInSeconds: agent.checkInSeconds,
			inventoryWanted,
			machineName: machine.name,
			localUsers: localUsersUpdate(tx, checkIn.localUsers)
		};
	});
}
