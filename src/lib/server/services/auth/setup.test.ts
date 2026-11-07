import { describe, expect, it } from 'vitest';
import { testDatabase } from '#tests/helpers/fake-agent.ts';
import { CLIENT, NOW, PASSWORD } from '#tests/helpers/people.ts';
import { users } from '../../database/schema.ts';
import { needsSetupRedirect } from '../../hooks/setup-redirect.ts';
import { hasUsers } from '../users/users.ts';
import { findSession } from './sessions.ts';
import { setupFirstAdmin } from './setup.ts';

describe('first-run setup (S1)', () => {
	it('sends every page to /setup while there are no users, and nothing afterwards', () => {
		for (const path of ['/', '/login', '/users', '/machines/abc']) {
			expect(needsSetupRedirect(path, false), path).toBe(true);
		}
		// /setup itself, the API (guards answer 401), assets and agents are left alone.
		for (const path of [
			'/setup',
			'/api/users',
			'/_app/x.js',
			'/agent/v1/check-in',
			'/install.sh'
		]) {
			expect(needsSetupRedirect(path, false), path).toBe(false);
		}
		expect(needsSetupRedirect('/', true)).toBe(false);
	});

	it('creates the first admin once, signed in, with a hashed password', async () => {
		const database = testDatabase();
		expect(hasUsers(database)).toBe(false);
		const result = await setupFirstAdmin(
			database,
			{ name: 'Jack', email: 'Jack@Example.com', password: PASSWORD },
			CLIENT,
			NOW
		);
		if (result.kind !== 'created') throw new Error('setup refused');
		expect(result.user).toMatchObject({ name: 'Jack', email: 'jack@example.com', role: 'admin' });
		expect(findSession(database, result.session.token, NOW)).toEqual({
			kind: 'active',
			userId: result.user.id
		});
		const [row] = database.select().from(users).all();
		expect(row?.passwordHash?.startsWith('$argon2id$')).toBe(true);

		const again = await setupFirstAdmin(
			database,
			{ name: 'Mallory', email: 'mallory@example.com', password: PASSWORD },
			CLIENT,
			NOW
		);
		expect(again).toEqual({ kind: 'closed' });
		expect(database.select().from(users).all()).toHaveLength(1);
	});
});
