import { and, eq, isNull } from 'drizzle-orm';
import type { ServerSocketMessage } from '#lib/schemas/agents/agent-protocol.ts';
import type { AppDatabase, Queryable } from '../../database/connection.ts';
import { machines } from '../../database/schema.ts';
import { recordAudit } from '../audit/audit.ts';

/**
 * Stay awake on mains power (SPEC-STAY-AWAKE). The server keeps the setting and sends it to the
 * agent when it changes and on every connect; the agent keeps the last one itself so it applies
 * after a restart. It changes the machine's behaviour, so only admins change it (the route's
 * guard) and every change is audited with the old and new value.
 */
export type PowerPolicyResult =
	{ kind: 'not-found' } | { kind: 'saved'; keepAwakeOnAc: boolean; delivered: boolean };

function onOff(value: boolean): string {
	return value ? 'on' : 'off';
}

export function setPowerPolicy(
	database: AppDatabase,
	machineId: string,
	actorUserId: string,
	keepAwakeOnAc: boolean,
	send: (message: ServerSocketMessage) => boolean,
	now: number
): PowerPolicyResult {
	const saved = database.transaction((tx) => {
		const machine = tx
			.select({ name: machines.name, keepAwakeOnAc: machines.keepAwakeOnAc })
			.from(machines)
			.where(and(eq(machines.id, machineId), isNull(machines.removedAt)))
			.get();
		if (machine === undefined) {
			return false;
		}
		if (machine.keepAwakeOnAc !== keepAwakeOnAc) {
			tx.update(machines).set({ keepAwakeOnAc }).where(eq(machines.id, machineId)).run();
			recordAudit(
				tx,
				{
					actor: { kind: 'user', userId: actorUserId },
					kind: 'machine-power-policy-changed',
					target: machine.name,
					machineId,
					detail: { from: onOff(machine.keepAwakeOnAc), to: onOff(keepAwakeOnAc) }
				},
				now
			);
		}
		return true;
	});
	if (!saved) {
		return { kind: 'not-found' };
	}
	// Sent even when unchanged, so an agent that missed it hears it again.
	const delivered = send({ type: 'power-policy', keepAwakeOnAc });
	return { kind: 'saved', keepAwakeOnAc, delivered };
}

/** The machine's setting; false for an unknown machine. */
export function keepAwakeOnAc(database: Queryable, machineId: string): boolean {
	const row = database
		.select({ keepAwakeOnAc: machines.keepAwakeOnAc })
		.from(machines)
		.where(eq(machines.id, machineId))
		.get();
	return row?.keepAwakeOnAc ?? false;
}

/** On every connect: the setting, so the agent's copy always matches the server's. */
export function powerPolicyOnConnect(database: Queryable, machineId: string): ServerSocketMessage {
	return { type: 'power-policy', keepAwakeOnAc: keepAwakeOnAc(database, machineId) };
}
