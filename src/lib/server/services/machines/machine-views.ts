import { and, eq, isNull } from 'drizzle-orm';
import { inventorySchema } from '#lib/schemas/agents/agent-protocol.ts';
import type { MachineUpdateState } from '#lib/domain/machines/agent-updates.ts';
import type {
	LiveFigures,
	Machine,
	MachineInventory,
	OsFamily,
	SignedInUser
} from '#lib/domain/machines/machine.ts';
import { lowDiskDrives, type LowDisk } from '#lib/domain/storage/storage.ts';
import { storedDrivesSchema } from '#lib/schemas/storage/storage.ts';
import {
	machineInventory,
	machineStatus,
	machineStorage,
	machines
} from '../../database/schema.ts';
import type { AppDatabase, Queryable } from '../../database/connection.ts';
import { recordAudit } from '../audit/audit.ts';
import { raiseNotification } from '../notifications/events.ts';
import { updateStates } from '../agents/agent-updates.ts';
import { disconnectAgent, liveFigures } from '../agents/live-agents.ts';
import { presenceOf } from '../agents/presence.ts';
import { sessionRelay } from '../sessions/relay.ts';
import type { ReleaseLookup } from '../agents/releases.ts';

type MachineRow = typeof machines.$inferSelect;
type StatusRow = typeof machineStatus.$inferSelect;
type InventoryRow = typeof machineInventory.$inferSelect;
type StorageRow = typeof machineStorage.$inferSelect;

/** Every machine that has not been removed, for the console, newest name first. */
export function listMachines(
	database: AppDatabase,
	now: number,
	releases: ReleaseLookup
): Machine[] {
	const rows = database
		.select()
		.from(machines)
		.leftJoin(machineStatus, eq(machineStatus.machineId, machines.id))
		.leftJoin(machineInventory, eq(machineInventory.machineId, machines.id))
		.leftJoin(machineStorage, eq(machineStorage.machineId, machines.id))
		.where(isNull(machines.removedAt))
		.orderBy(machines.name)
		.all();
	const updates = updateStates(
		database,
		rows.map((row) => row.machines),
		releases,
		now
	);
	return rows.map((row) =>
		toMachine(
			row.machines,
			row.machine_status,
			row.machine_inventory,
			row.machine_storage,
			updates,
			now
		)
	);
}

/**
 * Names of every machine that has not been removed, by id: for the access
 * service (the All machines group) and the group pickers.
 */
export function activeMachineNames(database: Queryable): Map<string, string> {
	const rows = database
		.select({ id: machines.id, name: machines.name })
		.from(machines)
		.where(isNull(machines.removedAt))
		.orderBy(machines.name)
		.all();
	return new Map(rows.map((row) => [row.id, row.name]));
}

/** The name and operating system of a machine that has not been removed (sessions need no more). */
export function activeMachineBasics(
	database: Queryable,
	id: string
): { name: string; osFamily: OsFamily } | undefined {
	return database
		.select({ name: machines.name, osFamily: machines.osFamily })
		.from(machines)
		.where(and(eq(machines.id, id), isNull(machines.removedAt)))
		.get();
}

/** True for a machine that is enrolled and has not been removed. */
export function isActiveMachine(database: Queryable, id: string): boolean {
	const row = database
		.select({ removedAt: machines.removedAt })
		.from(machines)
		.where(eq(machines.id, id))
		.get();
	return row?.removedAt === null;
}

export function findMachine(
	database: AppDatabase,
	id: string,
	now: number,
	releases: ReleaseLookup
): Machine | undefined {
	const row = database
		.select()
		.from(machines)
		.leftJoin(machineStatus, eq(machineStatus.machineId, machines.id))
		.leftJoin(machineInventory, eq(machineInventory.machineId, machines.id))
		.leftJoin(machineStorage, eq(machineStorage.machineId, machines.id))
		.where(eq(machines.id, id))
		.get();
	if (row === undefined) {
		return undefined;
	}
	if (row.machines.removedAt !== null) {
		return undefined;
	}
	const updates = updateStates(database, [row.machines], releases, now);
	return toMachine(
		row.machines,
		row.machine_status,
		row.machine_inventory,
		row.machine_storage,
		updates,
		now
	);
}

/**
 * Removes a machine (SPEC-ENROLMENT 9): kept for the record, refused from now
 * on, and audited with the admin who removed it. False for an unknown id.
 */
export function removeMachine(
	database: AppDatabase,
	id: string,
	removedBy: string,
	now: number
): boolean {
	const removed = database.transaction((tx) => {
		const row = tx
			.select({ name: machines.name, hostname: machines.hostname, removedAt: machines.removedAt })
			.from(machines)
			.where(eq(machines.id, id))
			.get();
		if (row === undefined) {
			return false;
		}
		// Already removed: nothing to do, and nothing to audit twice.
		if (row.removedAt !== null) {
			return false;
		}
		tx.update(machines)
			.set({ removedAt: new Date(now) })
			.where(eq(machines.id, id))
			.run();
		raiseNotification(
			tx,
			{
				kind: 'machine-removed',
				machineId: id,
				detail: { machineName: row.name, hostname: row.hostname, removedByUserId: removedBy }
			},
			now
		);
		recordAudit(
			tx,
			{
				actor: { kind: 'user', userId: removedBy },
				kind: 'machine-removed',
				target: row.name,
				machineId: id,
				detail: { hostname: row.hostname }
			},
			now
		);
		return true;
	});
	disconnectAgent(id, 4001, 'revoked');
	return removed;
}

function toMachine(
	machine: MachineRow,
	status: StatusRow | null,
	inventory: InventoryRow | null,
	storage: StorageRow | null,
	updates: ReadonlyMap<string, MachineUpdateState>,
	now: number
): Machine {
	const known = toInventory(inventory);
	return {
		id: machine.id,
		name: machine.name,
		description: machine.description,
		hostname: machine.hostname,
		osFamily: machine.osFamily,
		target: machine.target,
		agentVersion: machine.agentVersion,
		update: updates.get(machine.id) ?? { kind: 'no-release' },
		lastUser:
			machine.lastUserName !== null && machine.lastUserSeenAt !== null
				? {
						kind: 'user',
						name: machine.lastUserName,
						seenIso: machine.lastUserSeenAt.toISOString()
					}
				: { kind: 'none' },
		status: presenceOf(machine, now),
		live: toLive(machine.id, status, now),
		inventory: known,
		enrolledIso: machine.enrolledAt.toISOString(),
		lastSeenIso: machine.lastSeenAt.toISOString(),
		inUse: sessionRelay().inUse(machine.id),
		lowDisk: toLowDisk(storage, known)
	};
}

/**
 * Nearly full drives (SPEC-STORAGE 12): from the latest check-in's per-drive summary, or from the
 * inventory's disks for an agent before 0.4.17 that reports none.
 */
function toLowDisk(storage: StorageRow | null, inventory: MachineInventory): LowDisk[] {
	if (storage !== null) {
		return lowDiskDrives(storedDrivesSchema.parse(JSON.parse(storage.drives)));
	}
	if (inventory.kind === 'known') {
		return lowDiskDrives(
			inventory.disks.map((disk) => ({
				mount: disk.mount,
				sizeBytes: disk.sizeBytes,
				freeBytes: disk.sizeBytes - disk.usedBytes
			}))
		);
	}
	return [];
}

function toLive(machineId: string, status: StatusRow | null, now: number): LiveFigures {
	if (status === null) {
		return { kind: 'none' };
	}
	const live = liveFigures(machineId);
	const fresher = (live?.atMs ?? 0) > status.updatedAt.getTime();
	return {
		kind: 'known',
		cpuPercent: fresher && live !== undefined ? live.cpuPercent : status.cpuPercent,
		memoryUsedBytes: fresher && live !== undefined ? live.memoryUsedBytes : status.memoryUsedBytes,
		// Counted on from the check-in that reported it (SPEC-MACHINE-DETAILS D12).
		uptimeSeconds:
			status.uptimeSeconds + Math.max(0, Math.floor((now - status.updatedAt.getTime()) / 1000)),
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
		network: data.network,
		gpus: data.gpus,
		display: data.display,
		power: data.power
	};
}
