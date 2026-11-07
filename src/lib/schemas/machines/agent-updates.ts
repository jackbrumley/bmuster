import { z } from 'zod';

/** POST /api/agent-updates/update-now (SPEC-AGENT-UPDATES): one machine, a selection, or all. */
export const updateNowRequestSchema = z.object({
	machines: z.discriminatedUnion('kind', [
		z.object({ kind: z.literal('all') }),
		z.object({
			kind: z.literal('some'),
			ids: z.array(z.uuid()).min(1, 'Choose at least one machine.').max(10_000)
		})
	])
});

export type UpdateNowRequest = z.infer<typeof updateNowRequestSchema>;

export const updateNowReplySchema = z.object({
	requested: z.int().min(0),
	skipped: z.array(z.object({ name: z.string(), reason: z.string() }))
});

/** POST /api/agent-updates/rollout: pause or resume the newest version's roll-out. */
export const rolloutRequestSchema = z.object({ action: z.enum(['pause', 'resume']) });

export const rolloutReplySchema = z.object({ changed: z.boolean() });

/** PATCH /api/machines/<id>/agent-pin: keep this machine on its agent version, or let it update. */
export const agentPinRequestSchema = z.object({ pinned: z.boolean() });

export const agentPinReplySchema = z.object({ pinned: z.boolean() });
