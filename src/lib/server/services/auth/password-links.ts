import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { passwordLinks } from '../../database/schema.ts';
import type { Queryable } from '../../database/connection.ts';
import { findUserById, type UserRow } from '../users/users.ts';

/**
 * Single-use links that set a password (SPEC-EMAIL E4, E5). The link carries
 * 32 random bytes; the database keeps only their SHA-256, so a copy of the
 * database cannot be turned into working links. A new link of the same kind
 * cancels the person's earlier ones, and using one cancels the rest.
 */
export type LinkPurpose = 'reset' | 'invitation';

export const RESET_LINK_MINUTES = 30;
export const INVITATION_LINK_DAYS = 7;

function lifetimeMs(purpose: LinkPurpose): number {
	switch (purpose) {
		case 'reset':
			return RESET_LINK_MINUTES * 60_000;
		case 'invitation':
			return INVITATION_LINK_DAYS * 24 * 60 * 60_000;
	}
}

function hashToken(token: string): string {
	return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** The path a link opens, under the console address. */
export function linkPath(purpose: LinkPurpose, token: string): string {
	switch (purpose) {
		case 'reset':
			return `/login/reset/${token}`;
		case 'invitation':
			return `/invite/${token}`;
	}
}

/** Makes a link and cancels the person's earlier unused links of the same kind. */
export function createPasswordLink(
	database: Queryable,
	userId: string,
	purpose: LinkPurpose,
	now: number
): { token: string; expiresAt: Date } {
	cancelLinks(database, userId, purpose, now);
	const token = randomBytes(32).toString('base64url');
	const expiresAt = new Date(now + lifetimeMs(purpose));
	database
		.insert(passwordLinks)
		.values({
			tokenHash: hashToken(token),
			userId,
			purpose,
			createdAt: new Date(now),
			expiresAt,
			usedAt: null
		})
		.run();
	return { token, expiresAt };
}

function cancelLinks(database: Queryable, userId: string, purpose: LinkPurpose, now: number): void {
	database
		.update(passwordLinks)
		.set({ usedAt: new Date(now) })
		.where(
			and(
				eq(passwordLinks.userId, userId),
				eq(passwordLinks.purpose, purpose),
				isNull(passwordLinks.usedAt)
			)
		)
		.run();
}

export type FoundLink = { kind: 'usable'; user: UserRow } | { kind: 'unusable' };

/**
 * A link that may still be used: the right kind, not used, not expired, for
 * someone who is not disabled. Every other case looks the same to the page.
 */
export function findUsableLink(
	database: Queryable,
	token: string,
	purpose: LinkPurpose,
	now: number
): FoundLink {
	const row = database
		.select()
		.from(passwordLinks)
		.where(eq(passwordLinks.tokenHash, hashToken(token)))
		.get();
	if (row?.purpose !== purpose || row.usedAt !== null || row.expiresAt.getTime() <= now) {
		return { kind: 'unusable' };
	}
	const user = findUserById(database, row.userId);
	if (user?.disabledAt !== null) {
		return { kind: 'unusable' };
	}
	return { kind: 'usable', user };
}

/** Marks every unused link of the person's as used: the one just used and any others. */
export function usePasswordLinks(database: Queryable, userId: string, now: number): void {
	cancelLinks(database, userId, 'reset', now);
	cancelLinks(database, userId, 'invitation', now);
}
