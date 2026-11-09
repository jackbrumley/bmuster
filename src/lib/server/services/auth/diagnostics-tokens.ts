import { createHash, randomBytes } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import {
	DIAGNOSTICS_TOKEN_PREFIX,
	type DiagnosticsTokenDays,
	type DiagnosticsTokenView
} from '#lib/domain/logs/diagnostics-tokens.ts';
import type { ConsoleUser } from '#lib/domain/users/user.ts';
import type { Queryable } from '../../database/connection.ts';
import { diagnosticsTokens, users } from '../../database/schema.ts';
import { canReadDiagnostics } from '../access/access.ts';
import { recordAudit } from '../audit/audit.ts';
import { findUserById, toConsoleUser } from '../users/users.ts';

/**
 * Read-only diagnostics tokens (SPEC-AGENT-LOGS 4): `bmd_` and 32 random bytes in base64url,
 * shown once. Only the SHA-256 is kept. A token works until it expires or is revoked, and only
 * while the admin who made it is still an enabled admin. It is accepted by the diagnostics guard
 * alone, on GET requests under /api/diagnostics.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const TOKEN_PATTERN = /^bmd_[A-Za-z0-9_-]{43}$/;
/** Use is audited at most once an hour per token. */
const AUDIT_EVERY_MS = 60 * 60 * 1000;

function hashOf(token: string): string {
	return createHash('sha256').update(token, 'utf8').digest('hex');
}

export type CreatedToken = { id: string; token: string; expiresAt: Date };

export function createDiagnosticsToken(
	database: Queryable,
	request: { name: string; days: DiagnosticsTokenDays; userId: string },
	now: number
): CreatedToken {
	const token = `${DIAGNOSTICS_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
	const id = crypto.randomUUID();
	const expiresAt = new Date(now + request.days * DAY_MS);
	database
		.insert(diagnosticsTokens)
		.values({
			id,
			name: request.name,
			tokenHash: hashOf(token),
			userId: request.userId,
			createdAt: new Date(now),
			expiresAt
		})
		.run();
	recordAudit(
		database,
		{
			actor: { kind: 'user', userId: request.userId },
			kind: 'diagnostics-token-created',
			target: request.name,
			machineId: null,
			detail: { expires: expiresAt.toISOString() }
		},
		now
	);
	return { id, token, expiresAt };
}

export function listDiagnosticsTokens(database: Queryable, now: number): DiagnosticsTokenView[] {
	return database
		.select({ token: diagnosticsTokens, ownerName: users.name })
		.from(diagnosticsTokens)
		.innerJoin(users, eq(users.id, diagnosticsTokens.userId))
		.orderBy(desc(diagnosticsTokens.createdAt))
		.all()
		.map(({ token, ownerName }) => ({
			id: token.id,
			name: token.name,
			ownerName,
			createdIso: token.createdAt.toISOString(),
			expiresIso: token.expiresAt.toISOString(),
			lastUsed:
				token.lastUsedAt === null
					? { kind: 'never' }
					: { kind: 'used', atIso: token.lastUsedAt.toISOString() },
			state:
				token.revokedAt !== null
					? 'revoked'
					: token.expiresAt.getTime() <= now
						? 'expired'
						: 'active'
		}));
}

export type RevokeResult = 'revoked' | 'not-found' | 'already-ended';

export function revokeDiagnosticsToken(
	database: Queryable,
	id: string,
	actorUserId: string,
	now: number
): RevokeResult {
	const row = database.select().from(diagnosticsTokens).where(eq(diagnosticsTokens.id, id)).get();
	if (row === undefined) {
		return 'not-found';
	}
	if (row.revokedAt !== null || row.expiresAt.getTime() <= now) {
		return 'already-ended';
	}
	database
		.update(diagnosticsTokens)
		.set({ revokedAt: new Date(now) })
		.where(eq(diagnosticsTokens.id, id))
		.run();
	recordAudit(
		database,
		{
			actor: { kind: 'user', userId: actorUserId },
			kind: 'diagnostics-token-revoked',
			target: row.name,
			machineId: null,
			detail: {}
		},
		now
	);
	return 'revoked';
}

export type TokenCheck =
	{ kind: 'valid'; tokenId: string; tokenName: string; user: ConsoleUser } | { kind: 'invalid' };

/**
 * The admin behind a bearer token, or invalid: unknown, revoked, expired, or its admin is
 * disabled or no longer an admin. A valid use is recorded; it is audited once an hour.
 */
export function authenticateDiagnosticsToken(
	database: Queryable,
	token: string,
	now: number
): TokenCheck {
	if (!TOKEN_PATTERN.test(token)) {
		return { kind: 'invalid' };
	}
	const row = database
		.select()
		.from(diagnosticsTokens)
		.where(eq(diagnosticsTokens.tokenHash, hashOf(token)))
		.get();
	if (row?.revokedAt !== null || row.expiresAt.getTime() <= now) {
		return { kind: 'invalid' };
	}
	const owner = findUserById(database, row.userId);
	if (owner?.disabledAt !== null) {
		return { kind: 'invalid' };
	}
	const user = toConsoleUser(owner);
	if (!canReadDiagnostics(user)) {
		return { kind: 'invalid' };
	}
	const audit = row.lastAuditedAt === null || now - row.lastAuditedAt.getTime() >= AUDIT_EVERY_MS;
	database
		.update(diagnosticsTokens)
		.set(
			audit
				? { lastUsedAt: new Date(now), lastAuditedAt: new Date(now) }
				: { lastUsedAt: new Date(now) }
		)
		.where(eq(diagnosticsTokens.id, row.id))
		.run();
	if (audit) {
		recordAudit(
			database,
			{
				actor: { kind: 'user', userId: user.id },
				kind: 'diagnostics-token-used',
				target: row.name,
				machineId: null,
				detail: {}
			},
			now
		);
	}
	return { kind: 'valid', tokenId: row.id, tokenName: row.name, user };
}
