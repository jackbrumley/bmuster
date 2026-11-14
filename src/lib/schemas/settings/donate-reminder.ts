import { z } from 'zod';
import { DONATE_CHOICES } from '#lib/domain/settings/donate-reminder.ts';

/** POST /api/settings/donate-reminder (SPEC-DONATE D5): what the admin pressed. */
export const donateAnswerRequestSchema = z.object({ answer: z.enum(DONATE_CHOICES) });

export const donateAnswerReplySchema = z.object({ answered: z.enum(DONATE_CHOICES) });
