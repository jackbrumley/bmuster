import { eq, isNull } from 'drizzle-orm';
import { inventorySchema } from '#lib/schemas/agents/agent-protocol.ts';
import type {
	LiveFigures,
	Machine,
	MachineInventory,
	SignedInUser
} from '#lib/domain/machines/machine.ts';
import { machineInventory, machineStatus, machines } from '../../database/schema.ts';
import type { AppDatabase } from '../../database/connection.ts';
import { disconnectAgent, isAgentConnected, liveFigures } from '../agents/live-agents.ts';

/** A machine with no socket and no check-in for this many intervals shows Offline. */
const OFFLINE_AFTER_INTERVALS = 3;

type MachineRow = typeof machines.$inferSelect;
type StatusRow = typeof machineStatus.$inferSelect;
type InventoryRow = typeof machineInventory.$inferSelect;

/** Every machine that has not been removed, for the console, newest name first. */
export function listMachines(database: AppDatabase, now: number): Machine[] {
	const rows = database
		.select()
		.from(machines)
		.leftJoin(machineStatus, eq(machineStatus.machineId, machines.id))
		.leftJoin(machineInventory, eq(machineInventory.machineId, machines.id))
		.where(isNull(machines.removedAt))
		.orderBy(machines.name)
		.all();
	return rows.map((row) => toMachine(row.machines, row.machine_status, row.machine_inventory, now));
}

export function findMachine(database: AppDatabase, id: string, now: number): Machine | undefined {
	const row = database
		.select()
		.from(machines)
		.leftJoin(machineStatus, eq(machineStatus.machineId, machines.id))
		.leftJoin(machineInventory, eq(machineInventory.machineId, machines.id))
		.where(eq(machines.id, id))
		.get();
	if (row === undefined) {
		return undefined;
	}
	if (row.machines.removedAt !== null) {
		return undefined;
	}
	return toMachine(row.machines, row.machine_status, row.machine_inventory, now);
}

/** Removes a machine (SPEC-ENROLMENT 9): kept for the record, refused from now on. */
export function removeMachine(database: AppDatabase, id: string, now: number): boolean {
	const result = database
		.update(machines)
		.set({ removedAt: new Date(now) })
		.where(eq(machines.id, id))
		.run();
	disconnectAgent(id, 4001, 'revoked');
	return result.changes === 1;
}

function toMachine(
	machine: MachineRow,
	status: StatusRow | null,
	inventory: InventoryRow | null,
	now: number
): Machine {
	const connected = isAgentConnected(machine.id);
	const recent =
		now - machine.lastSeenAt.getTime() < OFFLINE_AFTER_INTERVALS * machine.checkInSeconds * 1000;
	return {
		id: machine.id,
		name: machine.name,
		hostname: machine.hostname,
		osFamily: machine.osFamily,
		agentVersion: machine.agentVersion,
		status:
			connected || recent
				? { kind: 'online' }
				: { kind: 'offline', lastSeenIso: machine.lastSeenAt.toISOString() },
		live: toLive(machine.id, status),
		inventory: toInventory(inventory),
		enrolledIso: machine.enrolledAt.toISOString(),
		lastSeenIso: machine.lastSeenAt.toISOString()
	};
}

function toLive(machineId: string, status: StatusRow | null): LiveFigures {
	if (status === null) {
		return { kind: 'none' };
	}
	const live = liveFigures(machineId);
	const fresher = (live?.atMs ?? 0) > status.updatedAt.getTime();
	return {
		kind: 'known',
		cpuPercent: fresher && live !== undefined ? live.cpuPercent : status.cpuPercent,
		memoryUsedBytes: fresher && live !== undefined ? live.memoryUsedBytes : status.memoryUsedBytes,
		uptimeSeconds: status.uptimeSeconds,
		signedInUser: parseSignedInUser(status.signedInUser)
	};
}

function parseSignedInUser(json: string): SignedInUser {
	const value: unknown = JSON.parse(json);
	if (typeof value === 'object' && value !== null && 'kind' in value) {
		if (value.kind === 'none') {
			return { kind: 'none' };
		}
		if (value.kind === 'user' && 'name' in value && typeof value.name === 'string') {
			return { kind: 'user', name: value.name };
		}
	}
	throw new Error('machine_status.signed_in_user holds an unknown shape');
}

function toInventory(row: InventoryRow | null): MachineInventory {
	if (row === null) {
		return { kind: 'pending' };
	}
	// Stored after validation at check-in; parsing again keeps the types honest.
	const data = inventorySchema.parse(JSON.parse(row.data));
	return {
		kind: 'known',
		osName: data.os.name,
		osVersion: data.os.version,
		osBuild: data.os.build,
		updates: data.os.updatesPending,
		cpuModel: data.cpu.model,
		cpuCores: data.cpu.cores,
		memoryTotalBytes: data.memoryTotalBytes,
		disks: data.disks,
		displayCount: data.displays.length,
		addresses: data.network.flatMap((network) => network.addresses)
	};
}
