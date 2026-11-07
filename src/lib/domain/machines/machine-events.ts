import type { MachineStatus } from './machine.ts';

/**
 * A machine's status changed (SPEC-PRESENCE P5): what the console's live feed
 * sends. `atIso` is when the server noticed, so a browser can tell a pushed
 * status from one its page loaded later. Browser-safe.
 */
export type MachineStatusEvent = { machineId: string; status: MachineStatus; atIso: string };
