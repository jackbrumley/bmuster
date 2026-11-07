import { describe, expect, it } from 'vitest';
import { togglePermission, type Permission } from '#lib/domain/access/access.ts';
import { accessRuleRequestSchema } from '#lib/schemas/access/access.ts';
import { done } from '#tests/helpers/access.ts';
import { enrolFakeAgent, testDatabase, NO_RELEASES } from '#tests/helpers/fake-agent.ts';
import { addTestUser, NOW } from '#tests/helpers/people.ts';
import { updateSetting } from '../settings/settings.ts';
import { listMachines } from '../machines/machine-views.ts';
import { listUsers } from '../users/users.ts';
import { createGroup, deleteGroup, listMachineGroups, listUserGroups } from './groups.ts';
import { createRule, deleteRule, listAccessRules, newRuleDefaults, updateRule } from './rules.ts';

async function setUp() {
	const database = testDatabase();
	const admin = await addTestUser(database, {
		email: 'ada@example.com',
		role: 'admin',
		password: null
	});
	const it = done(createGroup(database, 'user', admin.id, { name: 'IT', description: '' }, NOW));
	const office = done(
		createGroup(database, 'machine', admin.id, { name: 'Office', description: '' }, NOW)
	);
	return { database, admin, it, office };
}

function request(permissions: Permission[]) {
	return accessRuleRequestSchema.safeParse({
		userGroupId: crypto.randomUUID(),
		machineGroupId: crypto.randomUUID(),
		permissions,
		consent: 'ask'
	});
}

describe('access rules (A4)', () => {
	it('A4: an admin creates, edits and deletes a rule', async () => {
		const { database, admin, it, office } = await setUp();
		const id = done(
			createRule(
				database,
				admin.id,
				{
					userGroupId: it,
					machineGroupId: office,
					permissions: ['view', 'terminal'],
					consent: 'unattended'
				},
				NOW
			)
		);
		expect(listAccessRules(database)).toEqual([
			{
				id,
				userGroupId: it,
				machineGroupId: office,
				permissions: ['view', 'terminal'],
				consent: 'unattended',
				createdIso: new Date(NOW).toISOString()
			}
		]);
		done(
			updateRule(
				database,
				admin.id,
				id,
				{
					userGroupId: it,
					machineGroupId: office,
					permissions: ['view', 'desktop-view', 'desktop-control'],
					consent: 'ask'
				},
				NOW
			)
		);
		expect(listAccessRules(database)).toMatchObject([
			{ id, permissions: ['view', 'desktop-view', 'desktop-control'], consent: 'ask' }
		]);
		done(deleteRule(database, admin.id, id, NOW));
		expect(listAccessRules(database)).toEqual([]);
		expect(deleteRule(database, admin.id, id, NOW)).toMatchObject({ kind: 'refused', status: 404 });
	});

	it('A4: every permission includes view, and control desktop includes watching it', () => {
		expect(request([]).success).toBe(false);
		expect(request(['terminal']).success).toBe(false);
		expect(request(['view', 'desktop-control']).success).toBe(false);
		expect(request(['view', 'view']).success).toBe(false);
		expect(request(['view']).success).toBe(true);
		expect(request(['view', 'desktop-view', 'desktop-control', 'share-links']).success).toBe(true);
	});

	it('A4: the rule form keeps the set complete as boxes are ticked and unticked', () => {
		expect(togglePermission([], 'desktop-control', true)).toEqual([
			'view',
			'desktop-view',
			'desktop-control'
		]);
		expect(
			togglePermission(['view', 'desktop-view', 'desktop-control'], 'desktop-view', false)
		).toEqual(['view']);
		expect(togglePermission(['view', 'terminal', 'files'], 'view', false)).toEqual([]);
		expect(togglePermission(['view'], 'files', true)).toEqual(['view', 'files']);
	});

	it('A4: a new rule starts from the Default for new access rules setting', async () => {
		const { database, admin } = await setUp();
		expect(newRuleDefaults(database)).toEqual({ permissions: ['view'], consent: 'unattended' });
		updateSetting(database, admin.id, 'defaultConsent', 'ask', NOW);
		expect(newRuleDefaults(database)).toEqual({ permissions: ['view'], consent: 'ask' });
	});

	it('A4: one rule per pair of groups, and both groups must exist', async () => {
		const { database, admin, it, office } = await setUp();
		const input = {
			userGroupId: it,
			machineGroupId: office,
			permissions: ['view'] satisfies Permission[],
			consent: 'ask' as const
		};
		done(createRule(database, admin.id, input, NOW));
		expect(createRule(database, admin.id, input, NOW)).toEqual({
			kind: 'refused',
			status: 409,
			message: 'There is already a rule for IT → Office. Change that one instead.'
		});
		expect(
			createRule(database, admin.id, { ...input, machineGroupId: crypto.randomUUID() }, NOW)
		).toMatchObject({ kind: 'refused', status: 404 });
	});
});

describe('deleting a group used by rules (A8)', () => {
	it('A8: deletes the rules that use it too, and never the people or machines', async () => {
		const { database, admin, it, office } = await setUp();
		const machineId = enrolFakeAgent(database, NOW).machineId;
		const lab = done(
			createGroup(database, 'machine', admin.id, { name: 'Lab', description: '' }, NOW)
		);
		const keep = done(
			createRule(
				database,
				admin.id,
				{ userGroupId: it, machineGroupId: lab, permissions: ['view'], consent: 'ask' },
				NOW
			)
		);
		done(
			createRule(
				database,
				admin.id,
				{ userGroupId: it, machineGroupId: office, permissions: ['view'], consent: 'ask' },
				NOW
			)
		);
		done(deleteGroup(database, 'machine', admin.id, office, NOW));
		expect(listAccessRules(database).map((rule) => rule.id)).toEqual([keep]);
		done(deleteGroup(database, 'user', admin.id, it, NOW));
		expect(listAccessRules(database)).toEqual([]);
		expect(listUserGroups(database)).toEqual([]);
		expect(listMachineGroups(database).map((group) => group.name)).toEqual(['All machines', 'Lab']);
		expect(listUsers(database).map((user) => user.id)).toEqual([admin.id]);
		expect(listMachines(database, NOW, NO_RELEASES).map((machine) => machine.id)).toEqual([
			machineId
		]);
	});
});
