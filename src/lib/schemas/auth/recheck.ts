import { z } from 'zod';

/**
 * The recent sign-in check's answer in a request (SPEC-COMMANDS C10, SPEC-TWO-FACTOR 2.7):
 * nothing while the sign-in is recent, else the password, or an authenticator code when
 * two-factor is on.
 */
export const recheckSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('none') }),
	z.object({ kind: z.literal('password'), password: z.string().min(1).max(1024) }),
	z.object({ kind: z.literal('code'), code: z.string().min(1).max(64) })
]);

export type RecheckRequest = z.infer<typeof recheckSchema>;
