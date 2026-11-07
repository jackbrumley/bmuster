import { describe, expect, it } from 'vitest';
import { done } from '#tests/helpers/access.ts';
import { testDatabase } from '#tests/helpers/fake-agent.ts';
import { addTestUser, NOW } from '#tests/helpers/people.ts';
import { createGroupRequestSchema } from '#lib/schemas/access/access.ts';
import { listUsers } from '../users/users.ts';
import {
	createGroup,
	deleteGroup,
	listUserGroups,
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
	const pat = await addTestUser(database, {
		email: 'pat@example.com',
		role: 'member',
		password: null
	});
	const sam = await addTestUser(database, {
		email: 'sam@example.com',
		role: 'member',
		password: null
	});
	return { database, admin, pat, sam };
}

describe('user groups (A1)', () => {
	it('A1: an admin creates, renames, describes and deletes a user group', async () => {
		const { database, admin } = await setUp();
		const id = done(
			createGroup(database, 'user', admin.id, { name: 'IT', description: 'Fixes things' }, NOW)
		);
		expect(listUserGroups(database)).toEqual([
			{ id, name: 'IT', description: 'Fixes things', memberIds: [] }
		]);
		done(
			updateGroupDetails(
				database,
				'user',
				admin.id,
				id,
				{ name: 'Helpdesk', description: '' },
				NOW + 1
			)
		);
		expect(listUserGroups(database)).toMatchObject([{ id, name: 'Helpdesk', description: '' }]);
		done(deleteGroup(database, 'user', admin.id, id, NOW + 2));
		expect(listUserGroups(database)).toEqual([]);
	});

	it('A1: refuses a name another group has, whatever its case, and a blank or long name', async () => {
		const { database, admin } = await setUp();
		done(createGroup(database, 'user', admin.id, { name: 'IT', description: '' }, NOW));
		expect(createGroup(database, 'user', admin.id, { name: 'it', description: '' }, NOW)).toEqual({
			kind: 'refused',
			status: 409,
			message: 'There is already a group called it.'
		});
		expect(createGroupRequestSchema.safeParse({ name: '  ', description: '' }).success).toBe(false);
		expect(
			createGroupRequestSchema.safeParse({ name: 'x'.repeat(81), description: '' }).success
		).toBe(false);
		expect(createGroupRequestSchema.parse({ name: '  Office ', description: ' ' })).toEqual({
			name: 'Office',
			description: ''
		});
	});

	it('A1: adds and removes members on the group, and sets a person’s groups from the Users page', async () => {
		const { database, admin, pat, sam } = await setUp();
		const it = done(createGroup(database, 'user', admin.id, { name: 'IT', description: '' }, NOW));
		const office = done(
			createGroup(database, 'user', admin.id, { name: 'Office', description: '' }, NOW)
		);
		done(setGroupMembers(database, 'user', admin.id, it, [pat.id, sam.id], NOW));
		expect(
			listUserGroups(database)
				.find((group) => group.id === it)
				?.memberIds.toSorted()
		).toEqual([pat.id, sam.id].toSorted());
		done(setGroupMembers(database, 'user', admin.id, it, [sam.id], NOW));
		expect(listUserGroups(database).find((group) => group.id === it)?.memberIds).toEqual([sam.id]);

		done(setGroupsOfMember(database, 'user', admin.id, pat.id, [it, office], NOW));
		const groups = listUserGroups(database);
		expect(groups.find((group) => group.id === it)?.memberIds.toSorted()).toEqual(
			[pat.id, sam.id].toSorted()
		);
		expect(groups.find((group) => group.id === office)?.memberIds).toEqual([pat.id]);
		done(setGroupsOfMember(database, 'user', admin.id, pat.id, [], NOW));
		expect(listUserGroups(database).flatMap((group) => group.memberIds)).toEqual([sam.id]);
	});

	it('A1: refuses unknown people and unknown groups', async () => {
		const { database, admin, pat } = await setUp();
		const it = done(createGroup(database, 'user', admin.id, { name: 'IT', description: '' }, NOW));
		const nobody = crypto.randomUUID();
		expect(setGroupMembers(database, 'user', admin.id, it, [nobody], NOW)).toMatchObject({
			kind: 'refused',
			status: 404
		});
		expect(
			setGroupsOfMember(database, 'user', admin.id, pat.id, [crypto.randomUUID()], NOW)
		).toMatchObject({ kind: 'refused', status: 404 });
		expect(
			updateGroupDetails(database, 'user', admin.id, nobody, { name: 'X', description: '' }, NOW)
		).toMatchObject({ kind: 'refused', status: 404 });
	});

	it('A8: deleting a user group never removes the people in it', async () => {
		const { database, admin, pat } = await setUp();
		const it = done(createGroup(database, 'user', admin.id, { name: 'IT', description: '' }, NOW));
		done(setGroupMembers(database, 'user', admin.id, it, [pat.id], NOW));
		done(deleteGroup(database, 'user', admin.id, it, NOW));
		expect(listUsers(database).map((user) => user.id)).toContain(pat.id);
	});
});
