import { describe, expect, it } from 'vitest';
import { testDatabase } from '#tests/helpers/fake-agent.ts';
import { addTestUser, CLIENT, NOW, PASSWORD } from '#tests/helpers/people.ts';
import { users } from '../../database/schema.ts';
import { listAudit } from '../audit/audit.ts';
import { resetAdminPassword } from './admin-reset.ts';
import { signInWithPassword } from './password-sign-in.ts';
import { findSession, startSession } from './sessions.ts';
import { disableUser } from '../users/users.ts';

describe('admin:reset (S19)', () => {
	it('sets a new password for an admin, ends their sessions and audits it', async () => {
		const database = testDatabase();
		const admin = await addTestUser(database, {
			email: 'ada@example.com',
			role: 'admin',
			password: PASSWORD
		});
		const session = startSession(database, admin.id, CLIENT, NOW);

		const result = await resetAdminPassword(database, ' Ada@Example.com ', NOW);
		if (result.kind !== 'reset') throw new Error(result.message);
		expect(result.email).toBe('ada@example.com');
		expect(result.password).toMatch(/^[A-Za-z0-9_-]{24}$/);

		expect(findSession(database, session.token, NOW)).toEqual({ kind: 'none' });
		const old = await signInWithPassword(
			database,
			{ email: 'ada@example.com', password: PASSWORD },
			CLIENT,
			NOW
		);
		expect(old.kind).toBe('refused');
		const fresh = await signInWithPassword(
			database,
			{ email: 'ada@example.com', password: result.password },
			CLIENT,
			NOW
		);
		expect(fresh.kind).toBe('signed-in');
		expect(listAudit(database, 10).find((entry) => entry.kind === 'user-password-set')).toEqual(
			expect.objectContaining({
				actorUserId: null,
				target: 'ada@example.com',
				detail: { how: 'reset from the server command line' }
			})
		);
	});

	it('gives an admin who signs in only through a provider a password (break-glass)', async () => {
		const database = testDatabase();
		await addTestUser(database, { email: 'sso@example.com', role: 'admin', password: null });
		const result = await resetAdminPassword(database, 'sso@example.com', NOW);
		expect(result.kind).toBe('reset');
		const [row] = database.select().from(users).all();
		expect(row?.passwordHash?.startsWith('$argon2id$')).toBe(true);
	});

	it('refuses members, disabled admins and unknown emails, changing nothing', async () => {
		const database = testDatabase();
		const member = await addTestUser(database, {
			email: 'mo@example.com',
			role: 'member',
			password: PASSWORD
		});
		const keeper = await addTestUser(database, {
			email: 'ada@example.com',
			role: 'admin',
			password: PASSWORD
		});
		const disabled = await addTestUser(database, {
			email: 'old@example.com',
			role: 'admin',
			password: PASSWORD
		});
		disableUser(database, keeper.id, disabled.id, NOW);
		const before = database.select().from(users).all();

		expect(await resetAdminPassword(database, 'mo@example.com', NOW)).toEqual({
			kind: 'refused',
			message:
				"mo@example.com is a member, not an admin. An admin resets members' passwords on the Users page."
		});
		expect(await resetAdminPassword(database, 'old@example.com', NOW)).toEqual({
			kind: 'refused',
			message: "old@example.com is disabled. Use another admin's account, or enable this one first."
		});
		expect(await resetAdminPassword(database, 'nobody@example.com', NOW)).toEqual({
			kind: 'refused',
			message: 'No account has the email nobody@example.com.'
		});
		expect(database.select().from(users).all()).toEqual(before);
		expect(member.passwordHash).toBe(before.find((row) => row.id === member.id)?.passwordHash);
		expect(listAudit(database, 10).map((entry) => entry.kind)).toEqual(['user-disabled']);
	});
});
