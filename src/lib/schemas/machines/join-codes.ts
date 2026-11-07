import { z } from 'zod';

/** POST /api/join-codes (SPEC-ENROLMENT 5 and 13). */
export const createJoinCodeRequestSchema = z.object({
	maxUses: z.int().min(1).max(100),
	minutes: z
		.int()
		.min(1)
		.max(7 * 24 * 60)
});

export const createJoinCodeReplySchema = z.object({
	id: z.uuid(),
	code: z.string(),
	expiresAtIso: z.iso.datetime(),
	maxUses: z.int()
});

/** GET /api/join-codes/<id>: what has happened to the code since it was made. */
export const joinCodeStatusReplySchema = z.object({
	maxUses: z.int(),
	uses: z.int(),
	expiresAtIso: z.iso.datetime(),
	state: z.enum(['open', 'used-up', 'expired']),
	/** Machines that joined with the code, newest first; removed ones are kept and marked. */
	machines: z.array(
		z.object({
			id: z.string(),
			name: z.string(),
			enrolledAtIso: z.iso.datetime(),
			removed: z.boolean()
		})
	)
});

export type JoinCodeStatusReply = z.infer<typeof joinCodeStatusReplySchema>;
