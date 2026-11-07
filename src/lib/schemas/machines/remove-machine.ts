import { z } from 'zod';

/** DELETE /api/machines/<id> (SPEC-ENROLMENT 9). */
export const removeMachineReplySchema = z.object({ removed: z.literal(true) });
