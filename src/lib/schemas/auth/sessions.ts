import { z } from 'zod';

/** The reply to "Sign out everywhere else" (SPEC-SIGN-IN S21): how many sessions ended. */
export const otherSessionsEndedReplySchema = z.object({ ended: z.number().int().nonnegative() });
