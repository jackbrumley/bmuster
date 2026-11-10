import { describe, expect, it } from 'vitest';
import { done } from '#tests/helpers/access.ts';
import { enrolFakeAgent, testDatabase, NO_RELEASES } from '#tests/helpers/fake-agent.ts';
import { addTestUser, NOW } from '#tests/helpers/people.ts';
import { listMachines, removeMachine } from '../machines/machine-views.ts';
import {
	createGroup,
	deleteGroup,
	listMachineGroups,
	setGroupMembers,
	setGroupsOfMember,
	updateGroupDetails
} from './groups.ts';
import { createRule } from './rules.ts';

async function setUp() {
	const database = testDatabase();
	const admin = await addTestUser(database, {
		email: 'ada@example.com',
		role: 'admin',
		password: null
	});
	const first = enrolFakeAgent(database, NOW).machineId;
	const second = enrolFakeAgent(database, NOW).machineId;
	return { database, admin, first, second };
}

function allMachinesId(database: ReturnType<typeof testDatabase>): string {
	const group = listMachineGroups(database).find(
		(candidate) => candidate.membership.kind === 'all-machines'
	);
	if (group === undefined) throw new Error('no All machines group');
	return group.id;
}

function earlyUpdatesId(database: ReturnType<typeof testDatabase>): string {
	const group = listMachineGroups(database).find((candidate) => candidate.builtIn === 'early');
	if (group === undefined) throw new Error('no Early updates group');
	return group.id;
}

function machineIdsOf(database: ReturnType<typeof testDatabase>, id: string): string[] {
	const group = listMachineGroups(database).find((candidate) => candidate.id === id);
	if (group?.membership.kind !== 'chosen') throw new Error(`no chosen group ${id}`);
	return group.membership.machineIds.toSorted();
}

describe('machine groups (A2)', () => {
	it('A2: an admin creates, renames, describes and deletes a machine group', async () => {
		const { database, admin } = await setUp();
		const id = done(
			createGroup(database, 'machine', admin.id, { name: 'Office', description: 'Front' }, NOW)
		);
		expect(listMachineGroups(database).find((group) => group.id === id)).toEqual({
			id,
			name: 'Office',
			description: 'Front',
			builtIn: 'none',
			membership: { kind: 'chosen', machineIds: [] }
		});
		done(
			updateGroupDetails(
				database,
				'machine',
				admin.id,
				id,
				{ name: 'Front office', description: 'Reception' },
				NOW
			)
		);
		expect(listMachineGroups(database).find((group) => group.id === id)).toMatchObject({
			name: 'Front office',
			description: 'Reception'
		});
		done(deleteGroup(database, 'machine', admin.id, id, NOW));
		expect(listMachineGroups(database).map((group) => group.builtIn)).toEqual([
			'all',
			'early',
			'test'
		]);
		expect(listMachineGroups(database)[1]?.id).toBe(earlyUpdatesId(database));
	});

	it('A2: adds and removes machines on the group and from a machine’s Manage tab', async () => {
		const { database, admin, first, second } = await setUp();
		const office = done(
			createGroup(database, 'machine', admin.id, { name: 'Office', description: '' }, NOW)
		);
		const lab = done(
			createGroup(database, 'machine', admin.id, { name: 'Lab', description: '' }, NOW)
		);
		done(setGroupMembers(database, 'machine', admin.id, office, [first, second], NOW));
		expect(machineIdsOf(database, office)).toEqual([first, second].toSorted());
		done(setGroupMembers(database, 'machine', admin.id, office, [second], NOW));
		expect(machineIdsOf(database, office)).toEqual([second]);

		done(setGroupsOfMember(database, 'machine', admin.id, first, [office, lab], NOW));
		expect(machineIdsOf(database, office)).toEqual([first, second].toSorted());
		expect(machineIdsOf(database, lab)).toEqual([first]);
		done(setGroupsOfMember(database, 'machine', admin.id, first, [lab], NOW));
		expect(machineIdsOf(database, office)).toEqual([second]);
	});

	it('A2: refuses removed and unknown machines, and leaves removed machines out of the list', async () => {
		const { database, admin, first, second } = await setUp();
		const office = done(
			createGroup(database, 'machine', admin.id, { name: 'Office', description: '' }, NOW)
		);
		done(setGroupMembers(database, 'machine', admin.id, office, [first, second], NOW));
		removeMachine(database, second, admin.id, NOW);
		expect(machineIdsOf(database, office)).toEqual([first]);
		expect(setGroupMembers(database, 'machine', admin.id, office, [second], NOW)).toMatchObject({
			kind: 'refused',
			status: 404
		});
		expect(setGroupsOfMember(database, 'machine', admin.id, second, [office], NOW)).toMatchObject({
			kind: 'refused',
			status: 404
		});
	});

	it('A8: deleting a machine group never removes the machines in it', async () => {
		const { database, admin, first } = await setUp();
		const office = done(
			createGroup(database, 'machine', admin.id, { name: 'Office', description: '' }, NOW)
		);
		done(setGroupMembers(database, 'machine', admin.id, office, [first], NOW));
		done(deleteGroup(database, 'machine', admin.id, office, NOW));
		expect(listMachines(database, NOW, NO_RELEASES).map((machine) => machine.id)).toContain(first);
	});
});

describe('All machines (A3)', () => {
	it('A3: exists from the start, listed first, holding every machine without storing them', async () => {
		const { database, admin } = await setUp();
		done(createGroup(database, 'machine', admin.id, { name: 'Aardvarks', description: '' }, NOW));
		const groups = listMachineGroups(database);
		expect(groups[0]).toMatchObject({
			name: 'All machines',
			builtIn: 'all',
			membership: { kind: 'all-machines' }
		});
		expect(groups.filter((group) => group.membership.kind === 'all-machines')).toHaveLength(1);
	});

	it('A3: cannot be deleted, renamed, described or have machines added or taken out', async () => {
		const { database, admin, first } = await setUp();
		const all = allMachinesId(database);
		const refused = { kind: 'refused', status: 409 };
		expect(deleteGroup(database, 'machine', admin.id, all, NOW)).toMatchObject(refused);
		expect(
			updateGroupDetails(
				database,
				'machine',
				admin.id,
				all,
				{ name: 'Everything', description: '' },
				NOW
			)
		).toMatchObject(refused);
		expect(setGroupMembers(database, 'machine', admin.id, all, [first], NOW)).toMatchObject(
			refused
		);
		expect(setGroupsOfMember(database, 'machine', admin.id, first, [all], NOW)).toMatchObject(
			refused
		);
		expect(listMachineGroups(database)[0]).toMatchObject({ id: all, name: 'All machines' });
		expect(
			createGroup(database, 'machine', admin.id, { name: 'all machines', description: '' }, NOW)
		).toMatchObject(refused);
	});
});

describe('Early updates (A11)', () => {
	it('A11: exists from the start, listed right after All machines, with no machines yet', async () => {
		const { database, admin } = await setUp();
		done(createGroup(database, 'machine', admin.id, { name: 'Aardvarks', description: '' }, NOW));
		const groups = listMachineGroups(database);
		expect(groups.map((group) => group.name)).toEqual([
			'All machines',
			'Early updates',
			'Test',
			'Aardvarks'
		]);
		expect(groups[1]).toMatchObject({
			builtIn: 'early',
			description:
				'New agent versions reach these machines first. Put one or two test machines here.',
			membership: { kind: 'chosen', machineIds: [] }
		});
	});

	it('A11: cannot be renamed, described or deleted, and says why', async () => {
		const { database, admin } = await setUp();
		const early = earlyUpdatesId(database);
		const refused = { kind: 'refused', status: 409 };
		expect(deleteGroup(database, 'machine', admin.id, early, NOW)).toMatchObject(refused);
		expect(
			updateGroupDetails(
				database,
				'machine',
				admin.id,
				early,
				{ name: 'Canaries', description: '' },
				NOW
			)
		).toMatchObject(refused);
		expect(
			createGroup(database, 'machine', admin.id, { name: 'early updates', description: '' }, NOW)
		).toMatchObject({ kind: 'refused', status: 409 });
		expect(listMachineGroups(database)[1]).toMatchObject({ id: early, name: 'Early updates' });
		const all = allMachinesId(database);
		const allRefusal = deleteGroup(database, 'machine', admin.id, all, NOW);
		expect(allRefusal.kind === 'refused' ? allRefusal.message : '').toMatch(
			/^All machines always holds every machine/
		);
		const earlyRefusal = deleteGroup(database, 'machine', admin.id, early, NOW);
		expect(earlyRefusal.kind === 'refused' ? earlyRefusal.message : '').toMatch(
			/^Early updates is built in/
		);
	});

	it('A11: machines are added and taken out on the group and from a machine’s Manage tab', async () => {
		const { database, admin, first, second } = await setUp();
		const early = earlyUpdatesId(database);
		done(setGroupMembers(database, 'machine', admin.id, early, [first, second], NOW));
		expect(machineIdsOf(database, early)).toEqual([first, second].toSorted());
		done(setGroupMembers(database, 'machine', admin.id, early, [first], NOW));
		expect(machineIdsOf(database, early)).toEqual([first]);
		done(setGroupsOfMember(database, 'machine', admin.id, second, [early], NOW));
		expect(machineIdsOf(database, early)).toEqual([first, second].toSorted());
		done(setGroupsOfMember(database, 'machine', admin.id, first, [], NOW));
		expect(machineIdsOf(database, early)).toEqual([second]);
	});

	it('A11: access rules may target it', async () => {
		const { database, admin, first } = await setUp();
		const early = earlyUpdatesId(database);
		done(setGroupMembers(database, 'machine', admin.id, early, [first], NOW));
		const testers = done(
			createGroup(database, 'user', admin.id, { name: 'Testers', description: '' }, NOW)
		);
		expect(
			createRule(
				database,
				admin.id,
				{
					userGroupId: testers,
					machineGroupId: early,
					permissions: ['view'],
					consent: 'ask'
				},
				NOW
			).kind
		).toBe('done');
	});
});

describe('Test (SPEC-TEST-CHANNEL T3)', () => {
	it('T3: is built in, cannot be renamed or deleted, and takes machines like Early updates', async () => {
		const { database, admin, first } = await setUp();
		const test = listMachineGroups(database).find((group) => group.builtIn === 'test');
		if (test === undefined) throw new Error('no Test group');
		expect(listMachineGroups(database)[2]).toMatchObject({ id: test.id, name: 'Test' });
		const refusal = deleteGroup(database, 'machine', admin.id, test.id, NOW);
		expect(refusal.kind === 'refused' ? refusal.message : '').toMatch(/^Test is built in/);
		expect(
			updateGroupDetails(
				database,
				'machine',
				admin.id,
				test.id,
				{ name: 'Beta', description: '' },
				NOW
			)
		).toMatchObject({ kind: 'refused', status: 409 });
		expect(
			createGroup(database, 'machine', admin.id, { name: 'test', description: '' }, NOW)
		).toMatchObject({ kind: 'refused', status: 409 });
		done(setGroupMembers(database, 'machine', admin.id, test.id, [first], NOW));
		expect(machineIdsOf(database, test.id)).toEqual([first]);
		done(setGroupsOfMember(database, 'machine', admin.id, first, [], NOW));
		expect(machineIdsOf(database, test.id)).toEqual([]);
	});
});
