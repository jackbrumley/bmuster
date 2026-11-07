import { describe, expect, it } from 'vitest';
import { testDatabase } from '#tests/helpers/fake-agent.ts';
import { addTestUser, NOW } from '#tests/helpers/people.ts';
import { consoleSessions } from '../../database/schema.ts';
import { disableUser } from '../users/users.ts';
import { authenticateSession } from './current-user.ts';
import {
	findSession,
	hashSessionToken,
	SESSION_COOKIE,
	SESSION_IDLE_MS,
	SESSION_MAX_MS,
	sessionCookieOptions,
	sessionCount,
	signOut,
	startSession
} from './sessions.ts';

const CLIENT = { ip: '192.0.2.1', userAgent: 'Vitest' };

describe('console sessions (S5)', () => {
	it('is a random 32-byte id; the database keeps only its SHA-256', async () => {
		const database = testDatabase();
		const user = await addTestUser(database, {
			email: 'a@example.com',
			role: 'admin',
			password: null
		});
		const { token, expiresAt } = startSession(database, user.id, CLIENT, NOW);
		expect(Buffer.from(token, 'base64url')).toHaveLength(32);
		expect(startSession(database, user.id, CLIENT, NOW).token).not.toBe(token);
		const rows = database.select().from(consoleSessions).all();
		expect(rows.map((row) => row.idHash)).toContain(hashSessionToken(token));
		expect(JSON.stringify(rows)).not.toContain(token);
		expect(hashSessionToken(token)).toMatch(/^[0-9a-f]{64}$/);
		expect(expiresAt.getTime()).toBe(NOW + SESSION_MAX_MS);
	});

	it('sits in an HttpOnly, Secure, SameSite=Lax cookie', () => {
		expect(SESSION_COOKIE).toBe('bmuster_session');
		const expires = new Date(NOW + SESSION_MAX_MS);
		expect(sessionCookieOptions(expires)).toEqual({
			path: '/',
			httpOnly: true,
			secure: true,
			sameSite: 'lax',
			expires
		});
	});

	it('ends after 12 hours idle', async () => {
		const database = testDatabase();
		const user = await addTestUser(database, {
			email: 'a@example.com',
			role: 'admin',
			password: null
		});
		const { token } = startSession(database, user.id, CLIENT, NOW);
		const nearlyIdle = NOW + SESSION_IDLE_MS - 1;
		expect(findSession(database, token, nearlyIdle).kind).toBe('active');
		// That request counted: another 12 hours from it.
		const later = nearlyIdle + SESSION_IDLE_MS - 1;
		expect(findSession(database, token, later).kind).toBe('active');
		expect(findSession(database, token, later + SESSION_IDLE_MS).kind).toBe('none');
		expect(sessionCount(database, user.id)).toBe(0);
	});

	it('ends 30 days after it started, however busy', async () => {
		const database = testDatabase();
		const user = await addTestUser(database, {
			email: 'a@example.com',
			role: 'admin',
			password: null
		});
		const { token } = startSession(database, user.id, CLIENT, NOW);
		for (let at = NOW; at < NOW + SESSION_MAX_MS; at += SESSION_IDLE_MS / 2) {
			expect(findSession(database, token, at).kind).toBe('active');
		}
		expect(findSession(database, token, NOW + SESSION_MAX_MS).kind).toBe('none');
	});
});

describe('ending sessions (S6)', () => {
	it('sign-out ends that session only', async () => {
		const database = testDatabase();
		const user = await addTestUser(database, {
			email: 'a@example.com',
			role: 'admin',
			password: null
		});
		const first = startSession(database, user.id, CLIENT, NOW);
		const second = startSession(database, user.id, CLIENT, NOW);
		signOut(database, first.token, user.id, user.email, NOW);
		expect(findSession(database, first.token, NOW).kind).toBe('none');
		expect(findSession(database, second.token, NOW).kind).toBe('active');
	});

	it('disabling someone ends all their sessions at once', async () => {
		const database = testDatabase();
		const admin = await addTestUser(database, {
			email: 'admin@example.com',
			role: 'admin',
			password: null
		});
		const member = await addTestUser(database, {
			email: 'm@example.com',
			role: 'member',
			password: null
		});
		const tokens = [1, 2, 3].map(() => startSession(database, member.id, CLIENT, NOW).token);
		expect(disableUser(database, admin.id, member.id, NOW).kind).toBe('done');
		expect(sessionCount(database, member.id)).toBe(0);
		for (const token of tokens) {
			expect(authenticateSession(database, token, NOW)).toBeUndefined();
		}
	});
});
