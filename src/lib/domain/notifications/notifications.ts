/**
 * The notification catalogue and rules (SPEC-EMAIL E6). Browser-safe.
 *
 * A new event is one entry here (what it is called, when it happens, what
 * it carries) and one `notify` call where it happens; rules and delivery
 * need no change.
 */

export const NOTIFICATION_EVENT_KINDS = [
	'machine-enrolled',
	'machine-removed',
	'machine-offline',
	'machine-online'
] as const;

/** The events a rule can pick. The test notification is sent from a rule itself. */
export type NotificationEventKind = (typeof NOTIFICATION_EVENT_KINDS)[number];

type CatalogueEntry = {
	label: string;
	description: string;
	/** What the email tells people. */
	carries: readonly string[];
};

export const NOTIFICATION_CATALOGUE: Record<NotificationEventKind | 'test', CatalogueEntry> = {
	'machine-enrolled': {
		label: 'Machine enrolled',
		description: 'A new machine joins with a join code.',
		carries: ['Machine name', 'Host name', 'System', 'Groups it joined']
	},
	'machine-removed': {
		label: 'Machine removed',
		description: 'An admin removes a machine; its agent is refused from then on.',
		carries: ['Machine name', 'Host name', 'Who removed it']
	},
	'machine-offline': {
		label: 'Machine went offline',
		description:
			"A machine's live connection has been gone for a minute. Many machines go offline every evening, so pick the machines that matter.",
		carries: ['Machine name', 'Host name', 'When it went offline']
	},
	'machine-online': {
		label: 'Machine came back online',
		description: 'A machine that had gone offline connects again.',
		carries: ['Machine name', 'Host name', 'When it went offline']
	},
	test: {
		label: 'Test notification',
		description: 'Sent from a rule with Send test, to check who receives it.',
		carries: ['Which rule sent it']
	}
};

export function isNotificationEventKind(kind: string): kind is NotificationEventKind {
	return NOTIFICATION_EVENT_KINDS.some((known) => known === kind);
}

export type RuleScope =
	| { kind: 'any-machine' }
	| { kind: 'machine-group'; id: string; name: string }
	| { kind: 'machine'; id: string; name: string };

export type RuleRecipients =
	{ kind: 'user-group'; id: string; name: string } | { kind: 'addresses'; addresses: string[] };

/** One row of Settings → Notifications. */
export type NotificationRuleView = {
	id: string;
	eventKind: NotificationEventKind;
	scope: RuleScope;
	recipients: RuleRecipients;
	enabled: boolean;
	createdIso: string;
};

export function scopeLabel(scope: RuleScope): string {
	switch (scope.kind) {
		case 'any-machine':
			return 'Any machine';
		case 'machine-group':
			return `Machines in ${scope.name}`;
		case 'machine':
			return scope.name;
	}
}

export function recipientsLabel(recipients: RuleRecipients): string {
	switch (recipients.kind) {
		case 'user-group':
			return `People in ${recipients.name}`;
		case 'addresses':
			return recipients.addresses.join(', ');
	}
}

/** "Machine enrolled · Any machine": how a rule is named in its emails and the audit log. */
export function ruleDescription(rule: {
	eventKind: NotificationEventKind;
	scope: RuleScope;
}): string {
	return `${NOTIFICATION_CATALOGUE[rule.eventKind].label} · ${scopeLabel(rule.scope)}`;
}
