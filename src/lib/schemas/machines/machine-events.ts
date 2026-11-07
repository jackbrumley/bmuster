import { z } from 'zod';
import type { MachineStatusEvent } from '#lib/domain/machines/machine-events.ts';

/** The `status` event on GET /api/machines/events (SPEC-PRESENCE P5). */
export const MACHINE_STATUS_EVENT = 'status';

export const machineStatusEventSchema: z.ZodType<MachineStatusEvent> = z.object({
	machineId: z.string(),
	status: z.discriminatedUnion('kind', [
		z.object({ kind: z.literal('online') }),
		z.object({ kind: z.literal('offline'), sinceIso: z.string() })
	]),
	atIso: z.string()
});
