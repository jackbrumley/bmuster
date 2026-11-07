import { z } from 'zod';

/** `POST /api/machines/<id>/local-code` (SPEC-AGENT-LOCAL): the local page's current code. */
export const localCodeReplySchema = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('code'),
		code: z.string().regex(/^\d{6}$/),
		/** Until the code changes. */
		secondsLeft: z.int().min(1).max(30)
	}),
	/** The agent has not sent a local page secret (an older agent). */
	z.object({ kind: z.literal('not-reported') })
]);

export type LocalCodeReply = z.infer<typeof localCodeReplySchema>;
