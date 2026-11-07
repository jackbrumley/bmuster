import { describe, expect, it } from 'vitest';
import { testDatabase } from '#tests/helpers/fake-agent.ts';
import { addTestUser, CLIENT, NOW, PASSWORD } from '#tests/helpers/people.ts';
import { userIdentities } from '../../database/schema.ts';
import { addProvider } from '../auth/identity-providers.ts';
import { sessionCount, startSession } from '../auth/sessions.ts';
import {
	addUser,
	disableUser,
	enableUser,
	listUsers,
	setDetails,
	setPassword,
	setRole
} from './users.ts';

describe('users (S12)', () => {
	it('adds (invites) someone, with or without a password, once per email', async () => {
		const database = testDatabase();
		const admin = await addTestUser(database, {
			email: 'admin@example.com',
			role: 'admin',
			password: PASSWORD
		});
		const invited = await addUser(
			database,
			admin.id,
			{ name: 'Priya', email: 'Priya@Example.com', role: 'member', password: null },
			NOW
		);
		expect(invited).toMatchObject({
			kind: 'done',
			user: { email: 'priya@example.com', hasPassword: false, role: 'member' }
		});
		const withPassword = await addUser(
			database,
			admin.id,
			{ name: 'Tom', email: 'tom@example.com', role: 'admin', password: PASSWORD },
			NOW
		);
		expect(withPassword).toMatchObject({
			kind: 'done',
			user: { hasPassword: true, role: 'admin' }
		});
		expect(
			await addUser(
				database,
				admin.id,
				{ name: 'P2', email: 'priya@example.com', role: 'member', password: null },
				NOW
			)
		).toMatchObject({
			kind: 'refused',
			status: 409
		});
		expect(listUsers(database)).toHaveLength(3);
	});

	it('edits name and email, but not the email a provider keeps', async () => {
		const database = testDatabase();
		const admin = await addTestUser(database, {
			email: 'admin@example.com',
			role: 'admin',
			password: PASSWORD
		});
		const member = await addTestUser(database, {
			email: 'sam@example.com',
			role: 'member',
			password: PASSWORD
		});
		expect(
			setDetails(
				database,
				admin.id,
				member.id,
				{ name: 'Sam Lee', email: 'Sam.Lee@example.com' },
				NOW
			)
		).toMatchObject({
			kind: 'done',
			user: { name: 'Sam Lee', email: 'sam.lee@example.com' }
		});
		expect(
			setDetails(database, admin.id, member.id, { name: 'Sam', email: 'admin@example.com' }, NOW)
		).toMatchObject({ kind: 'refused', status: 409 });

		const provider = addProvider(
			database,
			admin.id,
			{
				name: 'Authentik',
				kind: 'authentik',
				issuer: 'https://auth.example/application/o/b/',
				clientId: 'c',
				clientSecret: 's',
				scopes: ['openid'],
				newPeople: 'invited',
				enabled: true
			},
			Buffer.alloc(32, 2),
			NOW
		);
		database
			.insert(userIdentities)
			.values({
				id: crypto.randomUUID(),
				userId: member.id,
				providerId: provider.id,
				subject: 'sub-1'
			})
			.run();
		expect(
			setDetails(database, admin.id, member.id, { name: 'Sam', email: 'sam@other.example' }, NOW)
		).toMatchObject({ kind: 'refused', status: 409 });
		expect(
			setDetails(
				database,
				admin.id,
				member.id,
				{ name: 'Samuel', email: 'sam.lee@example.com' },
				NOW
			)
		).toMatchObject({
			kind: 'done',
			user: { name: 'Samuel', providerNames: ['Authentik'] }
		});
	});

	it('changes roles, disables and enables', async () => {
		const database = testDatabase();
		const admin = await addTestUser(database, {
			email: 'admin@example.com',
			role: 'admin',
			password: PASSWORD
		});
		const member = await addTestUser(database, {
			email: 'm@example.com',
			role: 'member',
			password: null
		});
		expect(setRole(database, admin.id, member.id, 'admin', NOW)).toMatchObject({
			kind: 'done',
			user: { role: 'admin' }
		});
		expect(disableUser(database, admin.id, member.id, NOW)).toMatchObject({
			kind: 'done',
			user: { status: { kind: 'disabled' } }
		});
		expect(enableUser(database, admin.id, member.id, NOW)).toMatchObject({
			kind: 'done',
			user: { status: { kind: 'active' } }
		});
	});

	it('never disables or demotes the last active admin', async () => {
		const database = testDatabase();
		const admin = await addTestUser(database, {
			email: 'admin@example.com',
			role: 'admin',
			password: PASSWORD
		});
		const other = await addTestUser(database, {
			email: 'other@example.com',
			role: 'admin',
			password: PASSWORD
		});
		expect(disableUser(database, admin.id, other.id, NOW).kind).toBe('done');
		// `other` is disabled, so `admin` is the last active admin.
		expect(setRole(database, admin.id, admin.id, 'member', NOW)).toMatchObject({
			kind: 'refused',
			status: 409
		});
		expect(disableUser(database, admin.id, admin.id, NOW)).toMatchObject({
			kind: 'refused',
			status: 409
		});
		expect(enableUser(database, admin.id, other.id, NOW).kind).toBe('done');
		expect(setRole(database, admin.id, admin.id, 'member', NOW).kind).toBe('done');
	});

	it("resets a member's password and ends their sessions; another admin's is refused", async () => {
		const database = testDatabase();
		const admin = await addTestUser(database, {
			email: 'admin@example.com',
			role: 'admin',
			password: PASSWORD
		});
		const other = await addTestUser(database, {
			email: 'other@example.com',
			role: 'admin',
			password: PASSWORD
		});
		const member = await addTestUser(database, {
			email: 'm@example.com',
			role: 'member',
			password: null
		});
		startSession(database, member.id, CLIENT, NOW);
		expect(
			await setPassword(database, admin.id, member.id, 'a brand new password', NOW)
		).toMatchObject({ kind: 'done', user: { hasPassword: true } });
		expect(sessionCount(database, member.id)).toBe(0);
		expect(
			await setPassword(database, admin.id, other.id, 'a brand new password', NOW)
		).toMatchObject({ kind: 'refused', status: 409 });
		expect((await setPassword(database, admin.id, admin.id, 'my own new password', NOW)).kind).toBe(
			'done'
		);
	});
});
