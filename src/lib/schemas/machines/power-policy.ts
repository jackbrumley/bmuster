import { z } from 'zod';

/** PUT /api/machines/<id>/power-policy (SPEC-STAY-AWAKE): only a boolean. */
export const powerPolicyRequestSchema = z.object({ keepAwakeOnAc: z.boolean() }).strict();

export const powerPolicyReplySchema = z.object({
	keepAwakeOnAc: z.boolean(),
	/** Whether the agent was connected and was sent it now; otherwise it gets it when it connects. */
	delivered: z.boolean()
});
