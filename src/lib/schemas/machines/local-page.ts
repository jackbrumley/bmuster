import { z } from 'zod';

/** `POST /api/machines/<id>/local-code` (SPEC-AGENT-LOCAL): the local page's current code. */
export const localCodeReplySchema = z.discriminatedUnion('kind', [
	z.object({
		kind: z.literal('code'),
		code: z.string().regex(/^\d{6}$/),
		/** Until the code changes. */
		secondsLeft: z.int().min(1).max(30),
		/**
		 * `person`: the viewer's own code (SPEC-AGENT-LOCAL 7). `machine`: the shared code an
		 * older agent still takes; per-person codes need an agent update.
		 */
		scope: z.enum(['person', 'machine'])
	}),
	/** The agent has not sent a local page secret (an older agent). */
	z.object({ kind: z.literal('not-reported') }),
	/** The viewer is not among the people who may sign in to this machine's local page. */
	z.object({ kind: z.literal('not-listed') })
]);

export type LocalCodeReply = z.infer<typeof localCodeReplySchema>;
