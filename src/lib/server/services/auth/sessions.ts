import { createHash, randomBytes } from 'node:crypto';
import { eq, lt, or } from 'drizzle-orm';
import { consoleSessions } from '../../database/schema.ts';
import type { Queryable } from '../../database/connection.ts';
import { recordAudit } from '../audit/audit.ts';

/**
 * Console sessions (SPEC-SIGN-IN S5, S6): an opaque random id in a cookie;
 * the database keeps only its SHA-256. A session ends after 12 hours without
 * a request or 30 days after it started, whichever comes first.
 */
export const SESSION_COOKIE = 'bmuster_session';

export const SESSION_IDLE_MS = 12 * 60 * 60_000;
export const SESSION_MAX_MS = 30 * 24 * 60 * 60_000;

/** `last_seen_at` is written at most this often, not on every request. */
const TOUCH_EVERY_MS = 60_000;

export type SessionCookieOptions = {
	path: '/';
	httpOnly: true;
	secure: true;
	sameSite: 'lax';
	expires: Date;
};

/** HttpOnly, always Secure, SameSite=Lax; the browser drops it at the 30-day limit. */
export function sessionCookieOptions(expiresAt: Date): SessionCookieOptions {
	return { path: '/', httpOnly: true, secure: true, sameSite: 'lax', expires: expiresAt };
}

export type StartedSession = { token: string; expiresAt: Date };

export function hashSessionToken(token: string): string {
	return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function startSession(
	database: Queryable,
	userId: string,
	client: { userAgent: string; ip: string },
	now: number
): StartedSession {
	const token = randomBytes(32).toString('base64url');
	const expiresAt = new Date(now + SESSION_MAX_MS);
	database
		.insert(consoleSessions)
		.values({
			idHash: hashSessionToken(token),
			userId,
			createdAt: new Date(now),
			lastSeenAt: new Date(now),
			expiresAt,
			userAgent: client.userAgent.slice(0, 300),
			ip: client.ip
		})
		.run();
	return { token, expiresAt };
}

export type FoundSession = { kind: 'none' } | { kind: 'active'; userId: string };

/** Looks up a cookie's session, ends it if it has run out, and records the request. */
export function findSession(database: Queryable, token: string, now: number): FoundSession {
	const idHash = hashSessionToken(token);
	const row = database
		.select()
		.from(consoleSessions)
		.where(eq(consoleSessions.idHash, idHash))
		.get();
	if (row === undefined) {
		return { kind: 'none' };
	}
	const idle = now - row.lastSeenAt.getTime() >= SESSION_IDLE_MS;
	if (idle || row.expiresAt.getTime() <= now) {
		database.delete(consoleSessions).where(eq(consoleSessions.idHash, idHash)).run();
		return { kind: 'none' };
	}
	if (now - row.lastSeenAt.getTime() >= TOUCH_EVERY_MS) {
		database
			.update(consoleSessions)
			.set({ lastSeenAt: new Date(now) })
			.where(eq(consoleSessions.idHash, idHash))
			.run();
	}
	return { kind: 'active', userId: row.userId };
}

export function endSession(database: Queryable, token: string): void {
	database
		.delete(consoleSessions)
		.where(eq(consoleSessions.idHash, hashSessionToken(token)))
		.run();
}

export function endSessionsForUser(database: Queryable, userId: string): void {
	database.delete(consoleSessions).where(eq(consoleSessions.userId, userId)).run();
}

/** Removes every session that has run out. Called at sign-in, so the table stays small. */
export function pruneSessions(database: Queryable, now: number): void {
	database
		.delete(consoleSessions)
		.where(
			or(
				lt(consoleSessions.expiresAt, new Date(now)),
				lt(consoleSessions.lastSeenAt, new Date(now - SESSION_IDLE_MS))
			)
		)
		.run();
}

/** How many sessions a person has open. */
export function sessionCount(database: Queryable, userId: string): number {
	return database
		.select({ idHash: consoleSessions.idHash })
		.from(consoleSessions)
		.where(eq(consoleSessions.userId, userId))
		.all().length;
}

/** Sign-out (S6): the session row goes, and the audit log says so. */
export function signOut(
	database: Queryable,
	token: string,
	userId: string,
	email: string,
	now: number
): void {
	endSession(database, token);
	recordAudit(
		database,
		{
			actor: { kind: 'user', userId },
			kind: 'sign-out',
			target: email,
			machineId: null,
			detail: {}
		},
		now
	);
}
