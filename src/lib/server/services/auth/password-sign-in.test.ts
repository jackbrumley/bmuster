import { describe, expect, it } from 'vitest';
import { testDatabase } from '#tests/helpers/fake-agent.ts';
import { addTestUser, CLIENT, NOW, PASSWORD } from '#tests/helpers/people.ts';
import { setPassword } from '../users/users.ts';
import { addProvider } from './identity-providers.ts';
import { signInWithPassword, WRONG_DETAILS } from './password-sign-in.ts';
import { findSession } from './sessions.ts';
import { ADDRESS_LIMIT, EMAIL_LIMIT, PAUSED } from './sign-in-limits.ts';

const KEY = Buffer.alloc(32, 9);

describe('password sign-in (S3)', () => {
	it('starts a session for the right email and password, in any case', async () => {
		const database = testDatabase();
		const user = await addTestUser(database, {
			email: 'jack@example.com',
			role: 'admin',
			password: PASSWORD
		});
		const result = await signInWithPassword(
			database,
			{ email: ' Jack@Example.com ', password: PASSWORD },
			CLIENT,
			NOW
		);
		if (result.kind !== 'signed-in') throw new Error(result.kind);
		expect(result.user.id).toBe(user.id);
		expect(findSession(database, result.session.token, NOW)).toEqual({
			kind: 'active',
			userId: user.id
		});
	});

	it('gives one plain message that does not say which part was wrong', async () => {
		const database = testDatabase();
		await addTestUser(database, { email: 'jack@example.com', role: 'admin', password: PASSWORD });
		const wrongPassword = await signInWithPassword(
			database,
			{ email: 'jack@example.com', password: 'not the password' },
			CLIENT,
			NOW
		);
		const unknownEmail = await signInWithPassword(
			database,
			{ email: 'nobody@example.com', password: PASSWORD },
			CLIENT,
			NOW
		);
		expect(wrongPassword).toEqual({ kind: 'refused', message: WRONG_DETAILS });
		expect(unknownEmail).toEqual(wrongPassword);
	});
});

describe('sign-in pauses (S4)', () => {
	it('pauses an email for 5 minutes after 5 failures, from any address', async () => {
		const database = testDatabase();
		await addTestUser(database, { email: 'jack@example.com', role: 'admin', password: PASSWORD });
		for (let attempt = 0; attempt < EMAIL_LIMIT.failures; attempt += 1) {
			const client = { ip: `198.51.100.${attempt}`, userAgent: 'Vitest' };
			await signInWithPassword(
				database,
				{ email: 'jack@example.com', password: 'guess guess guess' },
				client,
				NOW + attempt
			);
		}
		const lastFailure = NOW + EMAIL_LIMIT.failures - 1;
		const elsewhere = { ip: '203.0.113.7', userAgent: 'Vitest' };
		// Even the right password is refused while paused.
		expect(
			await signInWithPassword(
				database,
				{ email: 'jack@example.com', password: PASSWORD },
				elsewhere,
				lastFailure + 1000
			)
		).toEqual({ kind: 'refused', message: PAUSED });
		expect(
			await signInWithPassword(
				database,
				{ email: 'jack@example.com', password: PASSWORD },
				elsewhere,
				lastFailure + EMAIL_LIMIT.pauseMs - 1
			)
		).toEqual({ kind: 'refused', message: PAUSED });
		const after = await signInWithPassword(
			database,
			{ email: 'jack@example.com', password: PASSWORD },
			elsewhere,
			lastFailure + EMAIL_LIMIT.pauseMs
		);
		expect(after.kind).toBe('signed-in');
	});

	it('pauses an address after 20 failures in 10 minutes, whatever the emails', async () => {
		const database = testDatabase();
		await addTestUser(database, { email: 'jack@example.com', role: 'admin', password: PASSWORD });
		for (let attempt = 0; attempt < ADDRESS_LIMIT.failures; attempt += 1) {
			await signInWithPassword(
				database,
				{ email: `guess${attempt}@example.com`, password: 'guess guess guess' },
				CLIENT,
				NOW
			);
		}
		expect(
			await signInWithPassword(
				database,
				{ email: 'jack@example.com', password: PASSWORD },
				CLIENT,
				NOW + 1
			)
		).toEqual({ kind: 'refused', message: PAUSED });
		const otherAddress = { ip: '203.0.113.9', userAgent: 'Vitest' };
		expect(
			(
				await signInWithPassword(
					database,
					{ email: 'jack@example.com', password: PASSWORD },
					otherAddress,
					NOW + 1
				)
			).kind
		).toBe('signed-in');
		expect(
			(
				await signInWithPassword(
					database,
					{ email: 'jack@example.com', password: PASSWORD },
					CLIENT,
					NOW + ADDRESS_LIMIT.windowMs
				)
			).kind
		).toBe('signed-in');
	});
});

describe('passwords next to providers (S11)', () => {
	it('lets an admin sign in with a password while providers are on', async () => {
		const database = testDatabase();
		const admin = await addTestUser(database, {
			email: 'jack@example.com',
			role: 'admin',
			password: PASSWORD
		});
		addProvider(
			database,
			admin.id,
			{
				name: 'Microsoft 365',
				kind: 'microsoft-entra',
				issuer: 'https://login.microsoftonline.com/tenant/v2.0',
				clientId: 'client',
				clientSecret: 'secret',
				scopes: ['openid', 'email'],
				newPeople: 'invited',
				enabled: true
			},
			KEY,
			NOW
		);
		expect(
			(
				await signInWithPassword(
					database,
					{ email: 'jack@example.com', password: PASSWORD },
					CLIENT,
					NOW
				)
			).kind
		).toBe('signed-in');
	});

	it('gives a provider member no password until an admin sets one', async () => {
		const database = testDatabase();
		const admin = await addTestUser(database, {
			email: 'jack@example.com',
			role: 'admin',
			password: PASSWORD
		});
		const member = await addTestUser(database, {
			email: 'priya@example.com',
			role: 'member',
			password: null
		});
		expect(
			await signInWithPassword(
				database,
				{ email: 'priya@example.com', password: PASSWORD },
				CLIENT,
				NOW
			)
		).toEqual({ kind: 'refused', message: WRONG_DETAILS });
		expect((await setPassword(database, admin.id, member.id, PASSWORD, NOW)).kind).toBe('done');
		expect(
			(
				await signInWithPassword(
					database,
					{ email: 'priya@example.com', password: PASSWORD },
					CLIENT,
					NOW
				)
			).kind
		).toBe('signed-in');
	});
});
