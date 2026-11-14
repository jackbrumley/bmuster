import { z } from 'zod';
import type { NotificationEventKind } from '#lib/domain/notifications/notifications.ts';
import { notificationEvents } from '../../database/schema.ts';
import type { Queryable } from '../../database/connection.ts';

/**
 * Raising a notification event (SPEC-EMAIL E6). The code where something
 * happens calls `raiseNotification` inside its own transaction; the event
 * waits in the outbox until the email worker matches it against the rules.
 * This module needs nothing but its table, so any area can raise an event
 * without importing the rules, the groups or the queue.
 */
export const EVENT_DETAIL_SCHEMAS = {
	'machine-enrolled': z.object({
		machineName: z.string(),
		hostname: z.string(),
		system: z.string(),
		groups: z.string()
	}),
	'machine-removed': z.object({
		machineName: z.string(),
		hostname: z.string(),
		removedByUserId: z.string()
	}),
	'machine-offline': z.object({
		machineName: z.string(),
		hostname: z.string(),
		offlineSince: z.string()
	}),
	'machine-online': z.object({
		machineName: z.string(),
		hostname: z.string(),
		offlineSince: z.string()
	}),
	'disk-nearly-full': z.object({
		machineName: z.string(),
		hostname: z.string(),
		drive: z.string(),
		used: z.string(),
		free: z.string()
	}),
	'command-approval-requested': z.object({
		runId: z.string(),
		machines: z.string(),
		requestedBy: z.string(),
		assistant: z.string(),
		firstLine: z.string()
	})
} satisfies Record<NotificationEventKind, z.ZodType<Record<string, string>>>;

export type EventDetail<K extends NotificationEventKind> = z.infer<
	(typeof EVENT_DETAIL_SCHEMAS)[K]
>;

export function raiseNotification<K extends NotificationEventKind>(
	database: Queryable,
	event: { kind: K; machineId: string; detail: EventDetail<K> },
	now: number
): void {
	database
		.insert(notificationEvents)
		.values({
			id: crypto.randomUUID(),
			kind: event.kind,
			machineId: event.machineId,
			detail: JSON.stringify(event.detail),
			at: new Date(now)
		})
		.run();
}
