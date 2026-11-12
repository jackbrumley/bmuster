import type { Machine } from '#lib/domain/machines/machine.ts';
import { MachinePresence } from '#lib/runes/machine-presence.svelte.ts';
import PresenceFrame from './presence-frame.svelte';

/** The machine layout's live status for a tab rendered on its own, from the tab's page data. */
export function presenceOf(machine: Machine, loadedAtMs: number): MachinePresence {
	return new MachinePresence(() => ({
		machineId: machine.id,
		status: machine.status,
		loadedAtMs
	}));
}

/**
 * Render options that put a machine tab under its layout's live status
 * (SPEC-PRESENCE P10), as the third argument to `render`.
 */
export function underMachineLayout(presence: MachinePresence) {
	return { wrapper: PresenceFrame, wrapperProps: { presence } };
}
