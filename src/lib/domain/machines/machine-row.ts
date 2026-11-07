import { formatBytes, percentOf } from '#lib/utils/format.ts';
import { sortRows, type CellValue, type SortDirection } from '#lib/utils/sort-rows.ts';
import { matchesSearch, osLabel, type Machine } from './machine.ts';

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

export const MACHINE_FILTERS = ['all', 'online', 'offline', 'attention'] as const;

export type MachineFilter = (typeof MACHINE_FILTERS)[number];

/** The Table view's sortable columns, which a Machines export sorts by too. */
export const MACHINE_SORT_KEYS = [
	'name',
	'status',
	'os',
	'cpu',
	'memory',
	'disk',
	'lastUser',
	'lastSeen'
] as const;

export type MachineSortKey = (typeof MACHINE_SORT_KEYS)[number];

/**
 * The order on screen: Table view sorts by a column; Cards view keeps the
 * server's list order (by name).
 */
export type MachineOrder =
	{ kind: 'list' } | { kind: 'column'; column: MachineSortKey; direction: SortDirection };

/** What a Table column compares by. Online machines count as seen `now`, ahead of every offline one. */
export function machineSortValue(key: MachineSortKey, now: number): (row: MachineRow) => CellValue {
	switch (key) {
		case 'name':
			return (row) => row.machine.name;
		case 'status':
			return (row) => row.machine.status.kind;
		case 'os':
			return (row) => osLabel(row.machine);
		case 'cpu':
			return (row) => row.cpuPercent;
		case 'memory':
			return (row) => row.memoryPercent;
		case 'disk':
			return (row) => row.disk?.percent ?? null;
		case 'lastUser':
			return (row) => (row.machine.lastUser.kind === 'user' ? row.machine.lastUser.name : null);
		case 'lastSeen':
			return (row) =>
				row.machine.status.kind === 'online' ? now : Date.parse(row.machine.lastSeenIso);
	}
}

/** The rows the Machines page shows for this search and filter: the page and its export agree. */
export function machinesMatching(
	rows: readonly MachineRow[],
	search: string,
	filter: MachineFilter
): MachineRow[] {
	return rows.filter((row) => matchesFilter(row, filter) && matchesSearch(row.machine, search));
}

/** Every matching row in the order on screen, for the export (not just the batches drawn). */
export function machinesInOrder(
	rows: readonly MachineRow[],
	order: MachineOrder,
	now: number
): readonly MachineRow[] {
	switch (order.kind) {
		case 'list':
			return rows;
		case 'column':
			return sortRows(rows, machineSortValue(order.column, now), order.direction);
	}
}

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
