import type { MachineStatus } from './machine.ts';

/**
 * A machine's status changed (SPEC-PRESENCE P5): what the console's live feed
 * sends. `atIso` is when the server noticed, so a browser can tell a pushed
 * status from one its page loaded later. Browser-safe.
 */
export type MachineStatusEvent = { machineId: string; status: MachineStatus; atIso: string };

/** The machine's socket went at `atMs` (server time): Reconnecting since then (SPEC-PRESENCE P9, P11). */
export function reconnectingEvent(machineId: string, atMs: number): MachineStatusEvent {
	const atIso = new Date(atMs).toISOString();
	return { machineId, status: { kind: 'reconnecting', sinceIso: atIso }, atIso };
}
