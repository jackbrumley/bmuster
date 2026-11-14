import { describe, expect, it } from 'vitest';
import {
	PERMISSIONS,
	permissionLabel,
	isCompletePermissionSet,
	togglePermission
} from '#lib/domain/access/access.ts';
import { done, grantAccess } from '#tests/helpers/access.ts';
import { enrolFakeAgent, testDatabase } from '#tests/helpers/fake-agent.ts';
import { addTestUser, NOW } from '#tests/helpers/people.ts';
import { updateMachineDetails } from '../machines/machine-details.ts';
import { removeMachine } from '../machines/machine-views.ts';
import { activityFeed } from '../users/activity-feed.ts';
import { toConsoleUser } from '../users/users.ts';
import {
	activityScopeFor,
	canSeeMachine,
	machineIdsWith,
	permissionsFor,
	visibleMachineIds
} from './access.ts';
import { createRule } from './rules.ts';
import { createGroup, listMachineGroups, setGroupMembers } from './groups.ts';

async function setUp() {
	const database = testDatabase();
	const admin = toConsoleUser(
		await addTestUser(database, { email: 'ada@example.com', role: 'admin', password: null })
	);
	const pat = toConsoleUser(
		await addTestUser(database, { email: 'pat@example.com', role: 'member', password: null })
	);
	const office = enrolFakeAgent(database, NOW).machineId;
	const server = enrolFakeAgent(database, NOW).machineId;
	return { database, admin, pat, office, server };
}

describe('the access service (A5)', () => {
	it('A5: admins have every permission on every machine, unattended', async () => {
		const { database, admin, office } = await setUp();
		expect(permissionsFor(database, admin, office)).toEqual(
			PERMISSIONS.filter((permission) => permission !== 'ai-commands').map((permission) => ({
				permission,
				consent: 'unattended'
			}))
		);
		expect(canSeeMachine(database, admin, office)).toBe(true);
	});

	it('A5: a member with no rules has nothing', async () => {
		const { database, pat, office } = await setUp();
		expect(permissionsFor(database, pat, office)).toEqual([]);
		expect(canSeeMachine(database, pat, office)).toBe(false);
	});

	it('A5: a member has the union of every matching rule; unattended if any rule giving it says so', async () => {
		const { database, admin, pat, office } = await setUp();
		grantAccess(database, {
			adminId: admin.id,
			name: 'Helpdesk',
			memberIds: [pat.id],
			machineIds: [office],
			permissions: ['view', 'desktop-view', 'desktop-control', 'files'],
			consent: 'ask'
		});
		grantAccess(database, {
			adminId: admin.id,
			name: 'Engineers',
			memberIds: [pat.id],
			machineIds: [office],
			permissions: ['view', 'terminal'],
			consent: 'unattended'
		});
		expect(permissionsFor(database, pat, office)).toEqual([
			{ permission: 'view', consent: 'unattended' },
			{ permission: 'terminal', consent: 'unattended' },
			{ permission: 'desktop-view', consent: 'ask' },
			{ permission: 'desktop-control', consent: 'ask' },
			{ permission: 'files', consent: 'ask' }
		]);
	});

	it('A5: a rule on All machines covers every machine, including ones enrolled later', async () => {
		const { database, admin, pat, office, server } = await setUp();
		const people = done(
			createGroup(database, 'user', admin.id, { name: 'Ops', description: '' }, NOW)
		);
		done(setGroupMembers(database, 'user', admin.id, people, [pat.id], NOW));
		const all = listMachineGroups(database)[0];
		if (all === undefined) throw new Error('no All machines group');
		done(
			createRule(
				database,
				admin.id,
				{ userGroupId: people, machineGroupId: all.id, permissions: ['view'], consent: 'ask' },
				NOW
			)
		);
		const later = enrolFakeAgent(database, NOW).machineId;
		expect(visibleMachineIds(database, pat)).toEqual(new Set([office, server, later]));
		expect(permissionsFor(database, pat, later)).toEqual([{ permission: 'view', consent: 'ask' }]);
	});

	it('A5: rules stop applying when the member leaves the group or the machine leaves its group', async () => {
		const { database, admin, pat, office } = await setUp();
		const { userGroupId, machineGroupId } = grantAccess(database, {
			adminId: admin.id,
			name: 'IT',
			memberIds: [pat.id],
			machineIds: [office],
			permissions: ['view'],
			consent: 'ask'
		});
		expect(canSeeMachine(database, pat, office)).toBe(true);
		done(setGroupMembers(database, 'machine', admin.id, machineGroupId, [], NOW));
		expect(canSeeMachine(database, pat, office)).toBe(false);
		done(setGroupMembers(database, 'machine', admin.id, machineGroupId, [office], NOW));
		done(setGroupMembers(database, 'user', admin.id, userGroupId, [], NOW));
		expect(canSeeMachine(database, pat, office)).toBe(false);
	});
});

describe('what members see (A6)', () => {
	it('A6: members see only machines where a rule gives them view; admins see all', async () => {
		const { database, admin, pat, office, server } = await setUp();
		expect(visibleMachineIds(database, pat)).toEqual(new Set());
		grantAccess(database, {
			adminId: admin.id,
			name: 'IT',
			memberIds: [pat.id],
			machineIds: [office],
			permissions: ['view', 'terminal'],
			consent: 'unattended'
		});
		expect(visibleMachineIds(database, pat)).toEqual(new Set([office]));
		expect(canSeeMachine(database, pat, server)).toBe(false);
		expect(visibleMachineIds(database, admin)).toEqual(new Set([office, server]));
	});

	it('A6: a removed machine is seen by nobody', async () => {
		const { database, admin, pat, office } = await setUp();
		grantAccess(database, {
			adminId: admin.id,
			name: 'IT',
			memberIds: [pat.id],
			machineIds: [office],
			permissions: ['view'],
			consent: 'ask'
		});
		removeMachine(database, office, admin.id, NOW);
		expect(visibleMachineIds(database, pat)).toEqual(new Set());
		expect(permissionsFor(database, pat, office)).toEqual([]);
		expect(visibleMachineIds(database, admin).has(office)).toBe(false);
	});

	it('A6: Activity shows a member only entries about machines they can see', async () => {
		const { database, admin, pat, office, server } = await setUp();
		grantAccess(database, {
			adminId: admin.id,
			name: 'IT',
			memberIds: [pat.id],
			machineIds: [office],
			permissions: ['view'],
			consent: 'ask'
		});
		updateMachineDetails(
			database,
			office,
			{ name: 'Reception', description: '' },
			admin.id,
			NOW + 1
		);
		updateMachineDetails(database, server, { name: 'Build', description: '' }, admin.id, NOW + 2);
		const seen = activityFeed(database, activityScopeFor(database, pat), 50);
		expect(seen.map((entry) => entry.target)).toContain('Reception');
		expect(seen.map((entry) => entry.target)).not.toContain('Build');
		// Group and rule changes, sign-ins and other people's changes are admin-only.
		expect(seen.every((entry) => entry.kind.startsWith('machine-'))).toBe(true);
		expect(seen.some((entry) => entry.kind === 'access-rule-added')).toBe(false);
		const all = activityFeed(database, activityScopeFor(database, admin), 50);
		expect(all.map((entry) => entry.target)).toEqual(
			expect.arrayContaining(['Reception', 'Build'])
		);
		expect(all.some((entry) => entry.kind === 'access-rule-added')).toBe(true);
	});

	it('A6: a member who can see nothing gets an empty Activity page', async () => {
		const { database, admin, pat, office } = await setUp();
		updateMachineDetails(database, office, { name: 'Reception', description: '' }, admin.id, NOW);
		expect(activityFeed(database, activityScopeFor(database, pat), 50)).toEqual([]);
	});
});

describe('running commands (SPEC-COMMANDS C11)', () => {
	it('C11: run-commands is its own permission, labelled "Run commands", needing only view', () => {
		expect(PERMISSIONS).toContain('run-commands');
		expect(permissionLabel('run-commands')).toBe('Run commands');
		expect(isCompletePermissionSet(['run-commands'])).toBe(false);
		expect(togglePermission([], 'run-commands', true)).toEqual(['view', 'run-commands']);
		// Nothing else brings it along, not even the terminal or full desktop control.
		const everythingElse = PERMISSIONS.filter((permission) => permission !== 'run-commands');
		for (const permission of everythingElse) {
			expect(togglePermission([], permission, true)).not.toContain('run-commands');
		}
		expect(togglePermission(['view', 'run-commands', 'terminal'], 'terminal', false)).toEqual([
			'view',
			'run-commands'
		]);
	});

	it('C11: admins have it on every machine; a member only once a rule gives it', async () => {
		const { database, admin, pat, office, server } = await setUp();
		expect(permissionsFor(database, admin, office)).toContainEqual({
			permission: 'run-commands',
			consent: 'unattended'
		});
		expect(machineIdsWith(database, admin, 'run-commands')).toEqual(new Set([office, server]));
		grantAccess(database, {
			adminId: admin.id,
			name: 'Engineers',
			memberIds: [pat.id],
			machineIds: [office, server],
			permissions: ['view', 'terminal', 'desktop-view', 'desktop-control', 'files', 'share-links'],
			consent: 'unattended'
		});
		expect(permissionsFor(database, pat, office).map((grant) => grant.permission)).not.toContain(
			'run-commands'
		);
		expect(machineIdsWith(database, pat, 'run-commands')).toEqual(new Set());
		grantAccess(database, {
			adminId: admin.id,
			name: 'Fleet',
			memberIds: [pat.id],
			machineIds: [server],
			permissions: ['view', 'run-commands'],
			consent: 'unattended'
		});
		expect(machineIdsWith(database, pat, 'run-commands')).toEqual(new Set([server]));
		expect(machineIdsWith(database, pat, 'view')).toEqual(visibleMachineIds(database, pat));
	});
});

describe('AI commands (SPEC-MCP M3)', () => {
	it('M3: ai-commands includes view and nothing else, and nothing includes it', () => {
		expect(permissionLabel('ai-commands')).toBe('AI commands (with approval)');
		expect(togglePermission([], 'ai-commands', true)).toEqual(['view', 'ai-commands']);
		for (const other of PERMISSIONS.filter((permission) => permission !== 'ai-commands')) {
			expect(togglePermission([], other, true)).not.toContain('ai-commands');
		}
		expect(togglePermission(['view', 'ai-commands'], 'view', false)).toEqual([]);
	});

	it('M3: admins do not have ai-commands unless a rule gives it', async () => {
		const { database, admin, office, server } = await setUp();
		expect(
			permissionsFor(database, admin, office).map((grant) => grant.permission)
		).not.toContain('ai-commands');
		expect(machineIdsWith(database, admin, 'ai-commands').size).toBe(0);
		expect(machineIdsWith(database, admin, 'run-commands')).toEqual(new Set([office, server]));
		grantAccess(database, {
			adminId: admin.id,
			name: 'AI admins',
			memberIds: [admin.id],
			machineIds: [office],
			permissions: ['view', 'ai-commands'],
			consent: 'unattended'
		});
		expect(permissionsFor(database, admin, office).map((grant) => grant.permission)).toContain(
			'ai-commands'
		);
		expect(
			permissionsFor(database, admin, server).map((grant) => grant.permission)
		).not.toContain('ai-commands');
		expect(machineIdsWith(database, admin, 'ai-commands')).toEqual(new Set([office]));
	});

	it('M3: a member gets ai-commands only from a rule', async () => {
		const { database, admin, pat, office, server } = await setUp();
		grantAccess(database, {
			adminId: admin.id,
			name: 'Helpers',
			memberIds: [pat.id],
			machineIds: [office, server],
			permissions: ['view', 'terminal', 'run-commands'],
			consent: 'unattended'
		});
		expect(machineIdsWith(database, pat, 'ai-commands').size).toBe(0);
		grantAccess(database, {
			adminId: admin.id,
			name: 'AI helpers',
			memberIds: [pat.id],
			machineIds: [server],
			permissions: ['view', 'ai-commands'],
			consent: 'unattended'
		});
		expect(machineIdsWith(database, pat, 'ai-commands')).toEqual(new Set([server]));
	});
});
