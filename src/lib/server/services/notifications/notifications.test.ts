import { describe, expect, it } from 'vitest';
import { emailMessages, notificationEvents } from '../../database/schema.ts';
import type { AppDatabase } from '../../database/connection.ts';
import { done } from '#tests/helpers/access.ts';
import { enrolFakeAgent, testDatabase } from '#tests/helpers/fake-agent.ts';
import { emailSettingsFor, SECRETS_KEY, setUpEmail } from '#tests/helpers/email.ts';
import { addTestUser, NOW, PASSWORD } from '#tests/helpers/people.ts';
import { createGroup, listMachineGroups, setGroupMembers } from '../access/groups.ts';
import { listAudit } from '../audit/audit.ts';
import { removeMachine } from '../machines/machine-views.ts';
import { updateEmailSettings } from '../settings/email-settings.ts';
import { toConsoleUser } from '../users/users.ts';
import {
	createRule,
	deleteRule,
	listRules,
	updateRule,
	type RuleInput
} from './notification-rules.ts';
import { processNotificationEvents, sendTestNotification } from './notify.ts';

async function setUp() {
	const database = testDatabase();
	const admin = await addTestUser(database, {
		email: 'admin@example.test',
		role: 'admin',
		password: PASSWORD
	});
	setUpEmail(database, admin.id, 2525);
	return { database, admin };
}

function rule(overrides: Partial<RuleInput>): RuleInput {
	return {
		eventKind: 'machine-enrolled',
		scope: { kind: 'any-machine' },
		recipients: { kind: 'addresses', addresses: ['ops@example.test'] },
		enabled: true,
		...overrides
	};
}

function queuedTo(database: AppDatabase): string[] {
	return database
		.select()
		.from(emailMessages)
		.all()
		.map((row) => row.toAddress)
		.sort();
}

describe('notification rules (E6)', () => {
	it('sends nothing by default: an enrolment with no rules queues no email', async () => {
		const { database } = await setUp();
		enrolFakeAgent(database, NOW);
		expect(processNotificationEvents(database, NOW)).toBe(0);
		expect(queuedTo(database)).toEqual([]);
		expect(database.select().from(notificationEvents).all()).toHaveLength(0);
	});

	it('emails the listed addresses when a machine enrols, through the one notify path', async () => {
		const { database, admin } = await setUp();
		done(
			createRule(
				database,
				admin.id,
				rule({
					recipients: { kind: 'addresses', addresses: ['ops@example.test', 'b@example.test'] }
				}),
				NOW
			)
		);
		enrolFakeAgent(database, NOW);
		expect(processNotificationEvents(database, NOW)).toBe(2);
		expect(queuedTo(database)).toEqual(['b@example.test', 'ops@example.test']);
		const [message] = database.select().from(emailMessages).all();
		expect(message?.subject).toBe('New machine: Test machine');
	});

	it('emails the active people in a user group', async () => {
		const { database, admin } = await setUp();
		const one = await addTestUser(database, {
			email: 'one@example.test',
			role: 'member',
			password: null
		});
		const two = await addTestUser(database, {
			email: 'two@example.test',
			role: 'member',
			password: null
		});
		const groupId = done(
			createGroup(database, 'user', admin.id, { name: 'Ops', description: '' }, NOW)
		);
		done(setGroupMembers(database, 'user', admin.id, groupId, [one.id, two.id], NOW));
		done(
			createRule(database, admin.id, rule({ recipients: { kind: 'user-group', id: groupId } }), NOW)
		);
		enrolFakeAgent(database, NOW);
		processNotificationEvents(database, NOW);
		expect(queuedTo(database)).toEqual(['one@example.test', 'two@example.test']);
	});

	it('only fires for machines in scope: one machine, or a machine group', async () => {
		const { database, admin } = await setUp();
		const first = enrolFakeAgent(database, NOW);
		processNotificationEvents(database, NOW);
		const groupId = done(
			createGroup(database, 'machine', admin.id, { name: 'Servers', description: '' }, NOW)
		);
		done(setGroupMembers(database, 'machine', admin.id, groupId, [first.machineId], NOW));
		done(
			createRule(
				database,
				admin.id,
				rule({
					eventKind: 'machine-removed',
					scope: { kind: 'machine-group', id: groupId },
					recipients: { kind: 'addresses', addresses: ['group@example.test'] }
				}),
				NOW
			)
		);
		const second = enrolFakeAgent(database, NOW);
		done(
			createRule(
				database,
				admin.id,
				rule({
					eventKind: 'machine-removed',
					scope: { kind: 'machine', id: second.machineId },
					recipients: { kind: 'addresses', addresses: ['one@example.test'] }
				}),
				NOW
			)
		);
		removeMachine(database, first.machineId, admin.id, NOW);
		processNotificationEvents(database, NOW);
		expect(queuedTo(database)).toEqual(['group@example.test']);
		removeMachine(database, second.machineId, admin.id, NOW);
		processNotificationEvents(database, NOW);
		expect(queuedTo(database)).toEqual(['group@example.test', 'one@example.test']);
		const removal = database.select().from(emailMessages).all()[0];
		expect(removal?.subject).toBe('Machine removed: Test machine');
	});

	it('treats the All machines group as every machine', async () => {
		const { database, admin } = await setUp();
		const all = listMachineGroups(database).find(
			(group) => group.membership.kind === 'all-machines'
		);
		done(
			createRule(
				database,
				admin.id,
				rule({ scope: { kind: 'machine-group', id: all?.id ?? '' } }),
				NOW
			)
		);
		enrolFakeAgent(database, NOW);
		expect(processNotificationEvents(database, NOW)).toBe(1);
	});

	it('emails each address once per event, however many rules match', async () => {
		const { database, admin } = await setUp();
		done(createRule(database, admin.id, rule({}), NOW));
		done(createRule(database, admin.id, rule({}), NOW));
		enrolFakeAgent(database, NOW);
		expect(processNotificationEvents(database, NOW)).toBe(1);
	});

	it('skips switched-off rules, and drops events while email is off', async () => {
		const { database, admin } = await setUp();
		done(createRule(database, admin.id, rule({ enabled: false }), NOW));
		enrolFakeAgent(database, NOW);
		expect(processNotificationEvents(database, NOW)).toBe(0);
		done(createRule(database, admin.id, rule({}), NOW));
		updateEmailSettings(
			database,
			admin.id,
			{ ...emailSettingsFor(2525), enabled: false },
			SECRETS_KEY,
			NOW
		);
		enrolFakeAgent(database, NOW);
		expect(processNotificationEvents(database, NOW)).toBe(0);
		expect(database.select().from(notificationEvents).all()).toHaveLength(0);
	});

	it('lists, changes and deletes rules, auditing each change', async () => {
		const { database, admin } = await setUp();
		const id = done(createRule(database, admin.id, rule({}), NOW));
		expect(listRules(database)).toMatchObject([
			{
				id,
				eventKind: 'machine-enrolled',
				scope: { kind: 'any-machine' },
				recipients: { kind: 'addresses', addresses: ['ops@example.test'] },
				enabled: true
			}
		]);
		done(updateRule(database, admin.id, id, rule({ eventKind: 'machine-removed' }), NOW));
		expect(listRules(database)[0]?.eventKind).toBe('machine-removed');
		done(deleteRule(database, admin.id, id, NOW));
		expect(listRules(database)).toEqual([]);
		expect(listAudit(database, 3).map((entry) => entry.kind)).toEqual([
			'notification-rule-deleted',
			'notification-rule-changed',
			'notification-rule-added'
		]);
	});

	it('refuses a rule pointing at a group or machine that does not exist', async () => {
		const { database, admin } = await setUp();
		expect(
			createRule(
				database,
				admin.id,
				rule({ scope: { kind: 'machine', id: crypto.randomUUID() } }),
				NOW
			)
		).toMatchObject({ kind: 'refused', status: 400 });
		expect(
			createRule(
				database,
				admin.id,
				rule({ recipients: { kind: 'user-group', id: crypto.randomUUID() } }),
				NOW
			)
		).toMatchObject({ kind: 'refused', status: 400 });
	});

	it('sends a test notification to a rule’s recipients, whatever its scope', async () => {
		const { database, admin } = await setUp();
		const id = done(
			createRule(
				database,
				admin.id,
				rule({ scope: { kind: 'machine-group', id: listMachineGroups(database)[0]?.id ?? '' } }),
				NOW
			)
		);
		expect(sendTestNotification(database, toConsoleUser(admin), id, NOW)).toEqual({
			kind: 'queued',
			recipients: ['ops@example.test']
		});
		expect(database.select().from(emailMessages).all()[0]?.subject).toBe(
			'BMuster test notification'
		);
	});
});
