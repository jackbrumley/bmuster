import { formatBytes, percentOf } from '#lib/utils/format.ts';
import type { Machine } from '#lib/domain/machines/machine.ts';

/** The fullest disk, which is the one worth showing on the list. */
type DiskSummary = { mount: string; percent: number; detail: string };

/**
 * One machine with the figures the Machines list shows and sorts by,
 * worked out once per load rather than in every card, cell and comparison.
 */
export type MachineRow = {
	machine: Machine;
	disk: DiskSummary | undefined;
	updates: number;
	/** Pending updates, or a disk at 90% or more. */
	attention: boolean;
	/** Live CPU use while online; null when offline or not reported yet. */
	cpuPercent: number | null;
	/** Memory in use while online, as a share of the total; null when unknown. */
	memoryPercent: number | null;
};

export type MachineFilter = 'all' | 'online' | 'offline' | 'attention';

export function toMachineRow(machine: Machine): MachineRow {
	const disk = fullestDisk(machine);
	const updates =
		machine.inventory.kind === 'known' && machine.inventory.updates.kind === 'known'
			? machine.inventory.updates.count
			: 0;
	const live =
		machine.status.kind === 'online' && machine.live.kind === 'known' ? machine.live : undefined;
	return {
		machine,
		disk,
		updates,
		attention: updates > 0 || (disk !== undefined && disk.percent >= 90),
		cpuPercent: live === undefined ? null : Math.round(live.cpuPercent),
		memoryPercent:
			live === undefined || machine.inventory.kind !== 'known'
				? null
				: percentOf(live.memoryUsedBytes, machine.inventory.memoryTotalBytes)
	};
}

export function matchesFilter(row: MachineRow, filter: MachineFilter): boolean {
	switch (filter) {
		case 'all':
			return true;
		case 'online':
			return row.machine.status.kind === 'online';
		case 'offline':
			return row.machine.status.kind === 'offline';
		case 'attention':
			return row.attention;
	}
}

function fullestDisk(machine: Machine): DiskSummary | undefined {
	if (machine.inventory.kind !== 'known' || machine.inventory.disks.length === 0) {
		return undefined;
	}
	const disk = machine.inventory.disks.reduce((worst, current) =>
		percentOf(current.usedBytes, current.sizeBytes) > percentOf(worst.usedBytes, worst.sizeBytes)
			? current
			: worst
	);
	return {
		mount: disk.mount,
		percent: percentOf(disk.usedBytes, disk.sizeBytes),
		detail: `${formatBytes(disk.sizeBytes - disk.usedBytes)} free`
	};
}
