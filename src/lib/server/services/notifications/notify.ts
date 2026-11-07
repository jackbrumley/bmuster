import { asc, eq } from 'drizzle-orm';
import {
	isNotificationEventKind,
	NOTIFICATION_CATALOGUE,
	ruleDescription,
	type NotificationEventKind
} from '#lib/domain/notifications/notifications.ts';
import type { ConsoleUser } from '#lib/domain/users/user.ts';
import { notificationEvents } from '../../database/schema.ts';
import type { AppDatabase, Queryable } from '../../database/connection.ts';
import { listMachineGroups, listUserGroups, machineGroupIdsOf } from '../access/groups.ts';
import { enqueueEmail } from '../email/email-queue.ts';
import { notificationEmail, type RenderedEmail } from '../email/templates.ts';
import { emailReadiness, readEmailSettings } from '../settings/email-settings.ts';
import { findUserById } from '../users/users.ts';
import { EVENT_DETAIL_SCHEMAS } from './events.ts';
import {
	enabledRulesFor,
	findRule,
	ruleNames,
	ruleRecipients,
	ruleScope
} from './notification-rules.ts';

/**
 * The one notification service (SPEC-EMAIL E6). Events raised anywhere wait
 * in the outbox; each run matches them against the enabled rules for their
 * kind, checks the rule's scope (any machine, a machine group, one machine),
 * and queues one email per recipient (each address once per event). While
 * email is off, events are dropped rather than kept to flood in later.
 */
type EventRow = typeof notificationEvents.$inferSelect;

/** Turns waiting events into queued emails. Returns how many emails were queued. */
export function processNotificationEvents(database: AppDatabase, now: number): number {
	return database.transaction((transaction) => {
		const events = transaction
			.select()
			.from(notificationEvents)
			.orderBy(asc(notificationEvents.at))
			.limit(200)
			.all();
		const consoleUrl =
			emailReadiness(transaction).kind === 'ready'
				? readEmailSettings(transaction).consoleUrl
				: undefined;
		let queued = 0;
		for (const event of events) {
			if (consoleUrl !== undefined) {
				queued += deliverEvent(transaction, event, consoleUrl, now);
			}
			transaction.delete(notificationEvents).where(eq(notificationEvents.id, event.id)).run();
		}
		return queued;
	});
}

function deliverEvent(
	database: Queryable,
	event: EventRow,
	consoleUrl: string,
	now: number
): number {
	if (!isNotificationEventKind(event.kind)) {
		throw new Error(`notification_events ${event.id} has an unknown kind '${event.kind}'`);
	}
	const { rows, known } = enabledRulesFor(database, event.kind);
	if (rows.length === 0) {
		return 0;
	}
	const groupIds = new Set(machineGroupIdsOf(database, event.machineId));
	for (const group of listMachineGroups(database)) {
		if (group.membership.kind === 'all-machines') {
			groupIds.add(group.id);
		}
	}
	const sentTo = new Set<string>();
	for (const rule of rows) {
		const scope = ruleScope(rule, known);
		const inScope =
			scope.kind === 'any-machine' ||
			(scope.kind === 'machine' && scope.id === event.machineId) ||
			(scope.kind === 'machine-group' && groupIds.has(scope.id));
		if (!inScope) {
			continue;
		}
		const email = renderEvent(
			database,
			event,
			event.kind,
			consoleUrl,
			ruleDescription({ eventKind: event.kind, scope })
		);
		for (const address of recipientAddresses(database, ruleRecipients(rule, known))) {
			if (!sentTo.has(address)) {
				sentTo.add(address);
				enqueueEmail(
					database,
					{ kind: 'notification', to: address, email },
					{ kind: 'plain' },
					now
				);
			}
		}
	}
	return sentTo.size;
}

function renderEvent(
	database: Queryable,
	event: EventRow,
	kind: NotificationEventKind,
	consoleUrl: string,
	rule: string
): RenderedEmail {
	const raw: unknown = JSON.parse(event.detail);
	switch (kind) {
		case 'machine-enrolled': {
			const detail = EVENT_DETAIL_SCHEMAS[kind].parse(raw);
			return notificationEmail({
				subject: `New machine: ${detail.machineName}`,
				heading: 'A machine joined BMuster',
				summary: `${detail.machineName} enrolled with a join code.`,
				facts: [
					{ label: 'Machine', value: detail.machineName },
					{ label: 'Host name', value: detail.hostname },
					{ label: 'System', value: detail.system },
					{ label: 'Groups', value: detail.groups },
					{ label: 'When', value: event.at.toISOString() }
				],
				url: `${consoleUrl}/machines/${event.machineId}`,
				ruleDescription: rule
			});
		}
		case 'machine-removed': {
			const detail = EVENT_DETAIL_SCHEMAS[kind].parse(raw);
			const removedBy = findUserById(database, detail.removedByUserId)?.name ?? 'An admin';
			return notificationEmail({
				subject: `Machine removed: ${detail.machineName}`,
				heading: 'A machine was removed',
				summary: `${removedBy} removed ${detail.machineName}. Its agent is refused from now on.`,
				facts: [
					{ label: 'Machine', value: detail.machineName },
					{ label: 'Host name', value: detail.hostname },
					{ label: 'Removed by', value: removedBy },
					{ label: 'When', value: event.at.toISOString() }
				],
				url: `${consoleUrl}/`,
				ruleDescription: rule
			});
		}
	}
}

/** The addresses a rule sends to: its list, or the active people in its user group. */
function recipientAddresses(
	database: Queryable,
	recipients: ReturnType<typeof ruleRecipients>
): string[] {
	switch (recipients.kind) {
		case 'addresses':
			return recipients.addresses;
		case 'user-group': {
			const group = listUserGroups(database).find((candidate) => candidate.id === recipients.id);
			return (group?.memberIds ?? []).flatMap((userId) => {
				const user = findUserById(database, userId);
				return user?.disabledAt === null ? [user.email] : [];
			});
		}
	}
}

export type TestNotification =
	| { kind: 'queued'; recipients: string[] }
	| { kind: 'refused'; status: 404 | 409; message: string };

/** A test notification (the catalogue's `test`) to everyone one rule names, whatever its scope. */
export function sendTestNotification(
	database: AppDatabase,
	actor: ConsoleUser,
	ruleId: string,
	now: number
): TestNotification {
	return database.transaction((transaction) => {
		const readiness = emailReadiness(transaction);
		if (readiness.kind !== 'ready') {
			return {
				kind: 'refused',
				status: 409,
				message: 'Email is not set up, so nothing can be sent. Set it up in Settings → Email.'
			};
		}
		const row = findRule(transaction, ruleId);
		if (row === undefined) {
			return { kind: 'refused', status: 404, message: 'No notification rule with this id.' };
		}
		const known = ruleNames(transaction);
		const recipients = recipientAddresses(transaction, ruleRecipients(row, known));
		if (recipients.length === 0) {
			return {
				kind: 'refused',
				status: 409,
				message: 'Nobody would receive it: the group has no active members.'
			};
		}
		const consoleUrl = readEmailSettings(transaction).consoleUrl;
		const scope = ruleScope(row, known);
		const description = isNotificationEventKind(row.eventKind)
			? ruleDescription({ eventKind: row.eventKind, scope })
			: row.eventKind;
		const email = notificationEmail({
			subject: 'BMuster test notification',
			heading: NOTIFICATION_CATALOGUE.test.label,
			summary: `${actor.name} sent this to check who a notification rule reaches. Nothing has happened to any machine.`,
			facts: [{ label: 'Rule', value: description }],
			url: `${consoleUrl}/`,
			ruleDescription: description
		});
		for (const address of [...new Set(recipients)]) {
			enqueueEmail(
				transaction,
				{ kind: 'notification', to: address, email },
				{ kind: 'plain' },
				now
			);
		}
		return { kind: 'queued', recipients: [...new Set(recipients)] };
	});
}
