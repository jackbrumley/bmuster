import { SvelteSet } from 'svelte/reactivity';
import type { SelectGroup } from '#lib/domain/commands/commands.ts';
import type { MachineRow } from '#lib/domain/machines/machine-row.ts';

/**
 * Select mode on the Machines page (SPEC-COMMANDS C1–C5): which machines are ticked, and the
 * chips that narrow the list. Ticks outlive a change of chips (C3); Done clears them (C1).
 */

/** A chip: a machine group, a system, or Online. */
export type SelectChip = `group:${string}` | 'windows' | 'linux' | 'online';

/** What the table and cards draw in each row. */
export type TickBoxes =
	| { kind: 'off' }
	| {
			kind: 'on';
			canTick: (machineId: string) => boolean;
			isTicked: (machineId: string) => boolean;
			toggle: (machineId: string) => void;
	  };

export class MachineSelection {
	active = $state(false);
	chips = $state<SelectChip[]>([]);
	readonly ticked = new SvelteSet<string>();

	start(): void {
		this.active = true;
	}

	/** Done: leaves select mode and forgets the ticks and chips. */
	finish(): void {
		this.active = false;
		this.chips = [];
		this.ticked.clear();
	}

	toggle(machineId: string): void {
		if (this.ticked.has(machineId)) {
			this.ticked.delete(machineId);
		} else {
			this.ticked.add(machineId);
		}
	}

	tickAll(machineIds: readonly string[]): void {
		for (const id of machineIds) {
			this.ticked.add(id);
		}
	}

	/** Any chip on: the list is narrowed, so Select all is offered (C3). */
	get narrowed(): boolean {
		return this.chips.length > 0;
	}

	/**
	 * C2: groups combine as "in any of these groups"; Windows and Linux as "either system";
	 * Online narrows further.
	 */
	matches(row: MachineRow, groups: readonly SelectGroup[]): boolean {
		const machine = row.machine;
		const groupIds = this.chips.flatMap((chip) =>
			chip.startsWith('group:') ? [chip.slice('group:'.length)] : []
		);
		if (
			groupIds.length > 0 &&
			!groups.some((group) => groupIds.includes(group.id) && group.machineIds.includes(machine.id))
		) {
			return false;
		}
		const systems = this.chips.filter((chip) => chip === 'windows' || chip === 'linux');
		if (systems.length > 0 && !systems.some((system) => system === machine.osFamily)) {
			return false;
		}
		return !this.chips.includes('online') || machine.status.kind === 'online';
	}
}
