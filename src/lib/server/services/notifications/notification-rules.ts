import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
	isNotificationEventKind,
	ruleDescription,
	type NotificationEventKind,
	type NotificationRuleView,
	type RuleRecipients,
	type RuleScope
} from '#lib/domain/notifications/notifications.ts';
import { notificationRules } from '../../database/schema.ts';
import type { AppDatabase, Queryable } from '../../database/connection.ts';
import { listMachineGroups, listUserGroups } from '../access/groups.ts';
import { recordAudit } from '../audit/audit.ts';
import { activeMachineNames } from '../machines/machine-views.ts';

/**
 * Notification rules (SPEC-EMAIL E6): which event, on which machines, to
 * whom. Admins make them on Settings → Notifications; nothing is on until
 * they do. Every change is audited.
 */
type RuleRow = typeof notificationRules.$inferSelect;

/** A rule as an admin sends it: ids only; names are looked up here. */
export type RuleInput = {
	eventKind: NotificationEventKind;
	scope: { kind: 'any-machine' } | { kind: 'machine-group' | 'machine'; id: string };
	recipients: { kind: 'user-group'; id: string } | { kind: 'addresses'; addresses: string[] };
	enabled: boolean;
};

export type RuleChange =
	{ kind: 'done'; id: string } | { kind: 'refused'; status: 400 | 404; message: string };

const addressesSchema = z.array(z.string());

/** Names to show for the groups and machines rules point at. */
type Names = {
	machineGroups: Map<string, string>;
	machines: Map<string, string>;
	userGroups: Map<string, string>;
};

export function ruleNames(database: Queryable): Names {
	return {
		machineGroups: new Map(listMachineGroups(database).map((group) => [group.id, group.name])),
		machines: activeMachineNames(database),
		userGroups: new Map(listUserGroups(database).map((group) => [group.id, group.name]))
	};
}

const GONE = '(deleted)';

export function ruleScope(row: RuleRow, known: Names): RuleScope {
	switch (row.scopeKind) {
		case 'any-machine':
			return { kind: 'any-machine' };
		case 'machine-group':
		case 'machine': {
			const id = row.scopeId ?? '';
			const name =
				(row.scopeKind === 'machine' ? known.machines : known.machineGroups).get(id) ?? GONE;
			return { kind: row.scopeKind, id, name };
		}
	}
}

export function ruleRecipients(row: RuleRow, known: Names): RuleRecipients {
	switch (row.recipientsKind) {
		case 'user-group': {
			const id = row.userGroupId ?? '';
			return { kind: 'user-group', id, name: known.userGroups.get(id) ?? GONE };
		}
		case 'addresses':
			return { kind: 'addresses', addresses: addressesSchema.parse(JSON.parse(row.addresses)) };
	}
}

function eventKindOf(row: RuleRow): NotificationEventKind {
	if (!isNotificationEventKind(row.eventKind)) {
		throw new Error(`notification_rules ${row.id} has an unknown event kind '${row.eventKind}'`);
	}
	return row.eventKind;
}

function toRuleView(row: RuleRow, known: Names): NotificationRuleView {
	return {
		id: row.id,
		eventKind: eventKindOf(row),
		scope: ruleScope(row, known),
		recipients: ruleRecipients(row, known),
		enabled: row.enabled,
		createdIso: row.createdAt.toISOString()
	};
}

export function listRules(database: Queryable): NotificationRuleView[] {
	const known = ruleNames(database);
	return database
		.select()
		.from(notificationRules)
		.orderBy(asc(notificationRules.createdAt))
		.all()
		.map((row) => toRuleView(row, known));
}

/** The enabled rules for one event kind, as rows plus the names to describe them. */
export function enabledRulesFor(
	database: Queryable,
	eventKind: NotificationEventKind
): { rows: RuleRow[]; known: Names } {
	const rows = database
		.select()
		.from(notificationRules)
		.where(eq(notificationRules.eventKind, eventKind))
		.all()
		.filter((row) => row.enabled);
	return { rows, known: ruleNames(database) };
}

export function findRule(database: Queryable, id: string): RuleRow | undefined {
	return database.select().from(notificationRules).where(eq(notificationRules.id, id)).get();
}

/** The columns for a rule, or why it points at something that does not exist. */
function columns(
	input: RuleInput,
	known: Names
):
	| { kind: 'ok'; values: Omit<RuleRow, 'id' | 'createdBy' | 'createdAt'> }
	| { kind: 'refused'; message: string } {
	if (input.scope.kind === 'machine-group' && !known.machineGroups.has(input.scope.id)) {
		return { kind: 'refused', message: 'That group of machines no longer exists.' };
	}
	if (input.scope.kind === 'machine' && !known.machines.has(input.scope.id)) {
		return { kind: 'refused', message: 'That machine no longer exists.' };
	}
	if (input.recipients.kind === 'user-group' && !known.userGroups.has(input.recipients.id)) {
		return { kind: 'refused', message: 'That group of people no longer exists.' };
	}
	return {
		kind: 'ok',
		values: {
			eventKind: input.eventKind,
			scopeKind: input.scope.kind,
			scopeId: input.scope.kind === 'any-machine' ? null : input.scope.id,
			recipientsKind: input.recipients.kind,
			userGroupId: input.recipients.kind === 'user-group' ? input.recipients.id : null,
			addresses: JSON.stringify(
				input.recipients.kind === 'addresses' ? input.recipients.addresses : []
			),
			enabled: input.enabled
		}
	};
}

function auditDetail(view: NotificationRuleView): Record<string, string> {
	return {
		recipients:
			view.recipients.kind === 'user-group'
				? `people in ${view.recipients.name}`
				: view.recipients.addresses.join(', '),
		enabled: view.enabled ? 'on' : 'off'
	};
}

export function createRule(
	database: AppDatabase,
	actorUserId: string,
	input: RuleInput,
	now: number
): RuleChange {
	return database.transaction((transaction) => {
		const known = ruleNames(transaction);
		const made = columns(input, known);
		if (made.kind === 'refused') {
			return { kind: 'refused', status: 400, message: made.message };
		}
		const row: RuleRow = {
			id: crypto.randomUUID(),
			...made.values,
			createdBy: actorUserId,
			createdAt: new Date(now)
		};
		transaction.insert(notificationRules).values(row).run();
		const view = toRuleView(row, known);
		recordAudit(
			transaction,
			{
				actor: { kind: 'user', userId: actorUserId },
				kind: 'notification-rule-added',
				target: ruleDescription(view),
				machineId: null,
				detail: auditDetail(view)
			},
			now
		);
		return { kind: 'done', id: row.id };
	});
}

export function updateRule(
	database: AppDatabase,
	actorUserId: string,
	id: string,
	input: RuleInput,
	now: number
): RuleChange {
	return database.transaction((transaction) => {
		const existing = findRule(transaction, id);
		if (existing === undefined) {
			return { kind: 'refused', status: 404, message: 'No notification rule with this id.' };
		}
		const known = ruleNames(transaction);
		const made = columns(input, known);
		if (made.kind === 'refused') {
			return { kind: 'refused', status: 400, message: made.message };
		}
		transaction
			.update(notificationRules)
			.set(made.values)
			.where(eq(notificationRules.id, id))
			.run();
		const view = toRuleView({ ...existing, ...made.values }, known);
		recordAudit(
			transaction,
			{
				actor: { kind: 'user', userId: actorUserId },
				kind: 'notification-rule-changed',
				target: ruleDescription(view),
				machineId: null,
				detail: auditDetail(view)
			},
			now
		);
		return { kind: 'done', id };
	});
}

export function deleteRule(
	database: AppDatabase,
	actorUserId: string,
	id: string,
	now: number
): RuleChange {
	return database.transaction((transaction) => {
		const existing = findRule(transaction, id);
		if (existing === undefined) {
			return { kind: 'refused', status: 404, message: 'No notification rule with this id.' };
		}
		const view = toRuleView(existing, ruleNames(transaction));
		transaction.delete(notificationRules).where(eq(notificationRules.id, id)).run();
		recordAudit(
			transaction,
			{
				actor: { kind: 'user', userId: actorUserId },
				kind: 'notification-rule-deleted',
				target: ruleDescription(view),
				machineId: null,
				detail: auditDetail(view)
			},
			now
		);
		return { kind: 'done', id };
	});
}
