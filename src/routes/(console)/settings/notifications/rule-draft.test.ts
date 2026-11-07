import { describe, expect, it } from 'vitest';
import { notificationRuleRequestSchema } from '#lib/schemas/notifications/notifications.ts';
import { draftOf, newDraft, requestOf } from './rule-draft.ts';

const GROUP = '7b0c64a4-5a8c-4c1f-9d55-7d8f0e5e2f10';

describe('a notification rule being edited (SPEC-EMAIL E6)', () => {
	it('E6: turns typed addresses into a list the server accepts, each once and in lower case', () => {
		const parsed = notificationRuleRequestSchema.parse(
			requestOf({ ...newDraft(), addresses: 'Ops@Example.test, b@example.test\nops@example.test' })
		);
		expect(parsed.recipients).toEqual({
			kind: 'addresses',
			addresses: ['ops@example.test', 'b@example.test']
		});
	});

	it('E6: a group scope with no group chosen is refused with a reason', () => {
		const parsed = notificationRuleRequestSchema.safeParse(
			requestOf({ ...newDraft(), scopeKind: 'machine-group', addresses: 'a@example.test' })
		);
		expect(parsed.error?.issues[0]?.message).toBe('Choose a group of machines.');
	});

	it('E6: an existing rule comes back unchanged through the form', () => {
		const rule = {
			id: crypto.randomUUID(),
			eventKind: 'machine-removed' as const,
			scope: { kind: 'machine-group' as const, id: GROUP, name: 'Servers' },
			recipients: { kind: 'addresses' as const, addresses: ['a@example.test'] },
			enabled: false,
			createdIso: '2026-11-07T00:00:00.000Z'
		};
		expect(notificationRuleRequestSchema.parse(requestOf(draftOf(rule)))).toEqual({
			eventKind: 'machine-removed',
			scope: { kind: 'machine-group', id: GROUP },
			recipients: { kind: 'addresses', addresses: ['a@example.test'] },
			enabled: false
		});
	});
});
