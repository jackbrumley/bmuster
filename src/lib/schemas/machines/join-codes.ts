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
	code: z.string(),
	expiresAtIso: z.iso.datetime(),
	maxUses: z.int()
});
