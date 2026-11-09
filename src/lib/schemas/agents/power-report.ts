import { z } from 'zod';
import type { PowerReport } from '#lib/domain/machines/power.ts';

/** The inventory's power report (SPEC-STAY-AWAKE); the Rust side is protocol/src/power.rs. */
export const powerReportSchema = z
	.discriminatedUnion('kind', [
		z.object({ kind: z.literal('unreported') }),
		z.object({
			kind: z.literal('reported'),
			source: z.enum(['mains', 'battery', 'unknown']),
			batteryPercent: z.number().int().min(0).max(100).nullable(),
			keepAwake: z.enum(['off', 'active', 'waiting-for-mains']),
			inhibitor: z.discriminatedUnion('kind', [
				z.object({ kind: z.literal('held') }),
				z.object({ kind: z.literal('none') }),
				z.object({ kind: z.literal('failed'), reason: z.string().max(2048) })
			])
		})
	])
	// Agents from before SPEC-STAY-AWAKE send none.
	.default({ kind: 'unreported' }) satisfies z.ZodType<PowerReport>;
