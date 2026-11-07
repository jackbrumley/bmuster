import type {
	NotificationEventKind,
	NotificationRuleView
} from '#lib/domain/notifications/notifications.ts';

/**
 * A notification rule while it is being edited: every choice kept, so
 * switching the scope or recipients back and forth loses nothing.
 */
export type RuleDraft = {
	eventKind: NotificationEventKind;
	scopeKind: 'any-machine' | 'machine-group' | 'machine';
	machineGroupId: string | null;
	machineId: string | null;
	recipientsKind: 'addresses' | 'user-group';
	userGroupId: string | null;
	/** As typed: one per line or comma separated. */
	addresses: string;
	enabled: boolean;
};

export function newDraft(): RuleDraft {
	return {
		eventKind: 'machine-enrolled',
		scopeKind: 'any-machine',
		machineGroupId: null,
		machineId: null,
		recipientsKind: 'addresses',
		userGroupId: null,
		addresses: '',
		enabled: true
	};
}

export function draftOf(rule: NotificationRuleView): RuleDraft {
	return {
		eventKind: rule.eventKind,
		scopeKind: rule.scope.kind,
		machineGroupId: rule.scope.kind === 'machine-group' ? rule.scope.id : null,
		machineId: rule.scope.kind === 'machine' ? rule.scope.id : null,
		recipientsKind: rule.recipients.kind,
		userGroupId: rule.recipients.kind === 'user-group' ? rule.recipients.id : null,
		addresses: rule.recipients.kind === 'addresses' ? rule.recipients.addresses.join('\n') : '',
		enabled: rule.enabled
	};
}

/** The request body for a draft; the server's schema (also run here) checks it. */
export function requestOf(draft: RuleDraft): unknown {
	return {
		eventKind: draft.eventKind,
		scope:
			draft.scopeKind === 'any-machine'
				? { kind: 'any-machine' }
				: {
						kind: draft.scopeKind,
						id: (draft.scopeKind === 'machine' ? draft.machineId : draft.machineGroupId) ?? ''
					},
		recipients:
			draft.recipientsKind === 'user-group'
				? { kind: 'user-group', id: draft.userGroupId ?? '' }
				: {
						kind: 'addresses',
						addresses: draft.addresses
							.split(/[\s,;]+/)
							.map((address) => address.trim())
							.filter((address) => address !== '')
					},
		enabled: draft.enabled
	};
}
