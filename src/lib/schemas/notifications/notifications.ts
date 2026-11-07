import { z } from 'zod';
import { NOTIFICATION_EVENT_KINDS } from '#lib/domain/notifications/notifications.ts';
import { emailSchema } from '../auth/sign-in.ts';

/**
 * POST /api/notification-rules and PATCH /api/notification-rules/<id>: a whole
 * rule (SPEC-EMAIL E6). Addresses are kept in lower case, each once.
 */
export const notificationRuleRequestSchema = z.object({
	eventKind: z.enum(NOTIFICATION_EVENT_KINDS),
	scope: z.discriminatedUnion('kind', [
		z.object({ kind: z.literal('any-machine') }),
		z.object({ kind: z.literal('machine-group'), id: z.uuid('Choose a group of machines.') }),
		z.object({ kind: z.literal('machine'), id: z.uuid('Choose a machine.') })
	]),
	recipients: z.discriminatedUnion('kind', [
		z.object({ kind: z.literal('user-group'), id: z.uuid('Choose a group of people.') }),
		z.object({
			kind: z.literal('addresses'),
			addresses: z
				.array(emailSchema)
				.min(1, 'Enter at least one email address.')
				.max(50, 'A rule sends to at most 50 addresses.')
				.transform((addresses) => [...new Set(addresses)])
		})
	]),
	enabled: z.boolean()
});

export const ruleChangedReplySchema = z.object({ id: z.uuid() });

/** POST /api/notification-rules/<id>/test. */
export const testNotificationReplySchema = z.object({ recipients: z.array(z.string()) });
