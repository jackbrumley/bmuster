import { z } from 'zod';
import { USER_MESSAGE_MAX_LENGTH } from '#lib/domain/machines/user-message.ts';

/** POST /api/machines/<id>/message: plain text for the person at the machine. */
export const userMessageRequestSchema = z.object({
	text: z
		.string()
		.trim()
		.min(1, 'Write a message first.')
		.max(USER_MESSAGE_MAX_LENGTH, `A message is at most ${USER_MESSAGE_MAX_LENGTH} characters.`)
});

export const userMessageReplySchema = z.object({ sent: z.literal(true) });
