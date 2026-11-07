import { describe, expect, it } from 'vitest';
import { done } from '#tests/helpers/access.ts';
import { enrolFakeAgent, testDatabase } from '#tests/helpers/fake-agent.ts';
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
		expect(listMachineGroups(database).map((group) => group.id)).toEqual([allMachinesId(database)]);
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
		expect(listMachines(database, NOW).map((machine) => machine.id)).toContain(first);
	});
});

describe('All machines (A3)', () => {
	it('A3: exists from the start, listed first, holding every machine without storing them', async () => {
		const { database, admin } = await setUp();
		done(createGroup(database, 'machine', admin.id, { name: 'Aardvarks', description: '' }, NOW));
		const groups = listMachineGroups(database);
		expect(groups[0]).toMatchObject({
			name: 'All machines',
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
