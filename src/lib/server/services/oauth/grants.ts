import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import { z } from 'zod';
import {
	assistantLabel,
	CONNECTED_WINDOW_MS,
	isMcpScope,
	type AssistantName,
	type AssistantStatus,
	type GrantView,
	type McpScope
} from '#lib/domain/mcp/mcp.ts';
import {
	oauthClients,
	oauthCodes,
	oauthGrants,
	oauthTokens,
	users
} from '../../database/schema.ts';
import type { AppDatabase, Queryable } from '../../database/connection.ts';
import { recordAudit, type AuditActor } from '../audit/audit.ts';
import type { ClientRecord } from './clients.ts';
import { assistantOf } from './clients.ts';
import {
	connectEligibility,
	turnMcpOff,
	writeMcpSettings,
	type McpSettings,
	type McpSettingsChange
} from './mcp-settings.ts';

/**
 * Grants: one person's Allow for one assistant (SPEC-MCP M7–M10, M14). A grant ends when the
 * person disconnects it, a refresh token is reused, it runs out, the person may no longer
 * connect, MCP is turned off, or an admin stops all AI access; its tokens stop working at once.
 * Every grant, refusal and ending is audited with the person as actor and the assistant as `via`.
 */

export const LIFETIMES = {
	codeMs: 60_000,
	accessMs: 60 * 60_000,
	refreshIdleMs: 7 * 24 * 60 * 60_000,
	refreshMaxMs: 30 * 24 * 60 * 60_000
} as const;

export type EndReason = NonNullable<(typeof oauthGrants.$inferSelect)['endedReason']>;

const storedScopes = z.array(z.string());

export function parseScopes(json: string): McpScope[] {
	return storedScopes.parse(JSON.parse(json)).filter(isMcpScope);
}

export function hashSecret(secret: string): string {
	return createHash('sha256').update(secret, 'utf8').digest('hex');
}

export function newSecret(prefix: 'bmac_' | 'bmat_' | 'bmrt_'): string {
	return `${prefix}${randomBytes(32).toString('base64url')}`;
}

/**
 * The audit detail for something an assistant did as the person (M13): Activity shows
 * "Jack Brumley via <assistant>".
 */
export function viaDetail(assistant: AssistantName, clientId: string): Record<string, string> {
	return {
		via: assistantLabel(assistant),
		viaClientId: clientId,
		viaVerified: assistant.identity.kind === 'verified' ? 'yes' : 'no'
	};
}

/** The audit detail naming an assistant something was done to: connected, refused, disconnected. */
function assistantDetail(assistant: AssistantName, clientId: string): Record<string, string> {
	return {
		assistant: assistantLabel(assistant),
		clientId,
		verified: assistant.identity.kind === 'verified' ? 'yes' : 'no'
	};
}

/** Allow on the consent screen: a new grant and its single-use code (M7, M8). */
export function allowClient(
	database: AppDatabase,
	allowed: {
		userId: string;
		client: ClientRecord;
		scopes: McpScope[];
		redirectUri: string;
		codeChallenge: string;
		resource: string;
	},
	now: number
): string {
	const code = newSecret('bmac_');
	database.transaction((transaction) => {
		const grantId = crypto.randomUUID();
		transaction
			.insert(oauthGrants)
			.values({
				id: grantId,
				userId: allowed.userId,
				oauthClientId: allowed.client.id,
				scopes: JSON.stringify(allowed.scopes),
				createdAt: new Date(now)
			})
			.run();
		transaction
			.insert(oauthCodes)
			.values({
				hash: hashSecret(code),
				grantId,
				codeChallenge: allowed.codeChallenge,
				redirectUri: allowed.redirectUri,
				resource: allowed.resource,
				scopes: JSON.stringify(allowed.scopes),
				expiresAt: new Date(now + LIFETIMES.codeMs)
			})
			.run();
		recordAudit(
			transaction,
			{
				actor: { kind: 'user', userId: allowed.userId },
				kind: 'mcp-client-allowed',
				target: assistantLabel(allowed.client.assistant),
				machineId: null,
				detail: {
					...assistantDetail(allowed.client.assistant, allowed.client.clientId),
					scopes: allowed.scopes.join(' '),
					redirect: new URL(allowed.redirectUri).host
				}
			},
			now
		);
	});
	return code;
}

/** Cancel on the consent screen, or Allow from someone who may not connect (M2, M7). */
export function refuseClient(
	database: Queryable,
	refused: { userId: string; client: ClientRecord; reason: 'cancelled' | 'not-allowed' },
	now: number
): void {
	recordAudit(
		database,
		{
			actor: { kind: 'user', userId: refused.userId },
			kind: 'mcp-client-refused',
			target: assistantLabel(refused.client.assistant),
			machineId: null,
			detail: {
				...assistantDetail(refused.client.assistant, refused.client.clientId),
				reason: refused.reason
			}
		},
		now
	);
}

type GrantFacts = {
	id: string;
	userId: string;
	scopes: McpScope[];
	createdAt: Date;
	endedAt: Date | null;
	lastUsedAt: Date | null;
	lastIp: string | null;
	assistant: AssistantName;
	clientId: string;
};

export function findGrant(database: Queryable, grantId: string): GrantFacts | undefined {
	const row = database
		.select({ grant: oauthGrants, client: oauthClients })
		.from(oauthGrants)
		.innerJoin(oauthClients, eq(oauthClients.id, oauthGrants.oauthClientId))
		.where(eq(oauthGrants.id, grantId))
		.get();
	return row === undefined
		? undefined
		: {
				id: row.grant.id,
				userId: row.grant.userId,
				scopes: parseScopes(row.grant.scopes),
				createdAt: row.grant.createdAt,
				endedAt: row.grant.endedAt,
				lastUsedAt: row.grant.lastUsedAt,
				lastIp: row.grant.lastIp,
				assistant: assistantOf(row.client),
				clientId: row.client.clientId
			};
}

/**
 * Ends a grant and every token and code it holds, and audits why. False when it had already
 * ended (nothing is written twice).
 */
export function endGrant(
	database: Queryable,
	grantId: string,
	ending: { reason: EndReason; actor: AuditActor },
	now: number
): boolean {
	const grant = findGrant(database, grantId);
	if (grant?.endedAt !== null) {
		return false;
	}
	database
		.update(oauthGrants)
		.set({ endedAt: new Date(now), endedReason: ending.reason })
		.where(and(eq(oauthGrants.id, grantId), isNull(oauthGrants.endedAt)))
		.run();
	database
		.update(oauthTokens)
		.set({ revokedAt: new Date(now) })
		.where(and(eq(oauthTokens.grantId, grantId), isNull(oauthTokens.revokedAt)))
		.run();
	database
		.update(oauthCodes)
		.set({ usedAt: new Date(now) })
		.where(and(eq(oauthCodes.grantId, grantId), isNull(oauthCodes.usedAt)))
		.run();
	recordAudit(
		database,
		{
			// The person whose grant it was is the subject; an admin's or the system's ending names them.
			actor: ending.actor.kind === 'system' ? { kind: 'user', userId: grant.userId } : ending.actor,
			kind: 'mcp-grant-ended',
			target: assistantLabel(grant.assistant),
			machineId: null,
			detail: {
				...assistantDetail(grant.assistant, grant.clientId),
				reason: ending.reason,
				grantOf: grant.userId
			}
		},
		now
	);
	return true;
}

/** Grants not ended, newest first. */
function liveGrantIds(database: Queryable, userId: string | undefined): string[] {
	return database
		.select({ id: oauthGrants.id })
		.from(oauthGrants)
		.where(
			userId === undefined
				? isNull(oauthGrants.endedAt)
				: and(isNull(oauthGrants.endedAt), eq(oauthGrants.userId, userId))
		)
		.orderBy(desc(oauthGrants.createdAt))
		.all()
		.map((row) => row.id);
}

/** Ends every grant whose person may no longer connect (M9): disabled, out of the group, MCP off. */
export function endIneligibleGrants(database: AppDatabase, now: number): number {
	let ended = 0;
	database.transaction((transaction) => {
		for (const id of liveGrantIds(transaction, undefined)) {
			const grant = findGrant(transaction, id);
			if (grant === undefined) continue;
			const eligibility = connectEligibility(transaction, grant.userId);
			if (eligibility.kind === 'ineligible') {
				if (
					endGrant(transaction, id, { reason: eligibility.why, actor: { kind: 'system' } }, now)
				) {
					ended += 1;
				}
			}
		}
	});
	return ended;
}

/** True while a grant still holds a token or code that works. */
function hasLiveCredential(database: Queryable, grantId: string, now: number): boolean {
	const at = new Date(now);
	const code = database
		.select({ hash: oauthCodes.hash })
		.from(oauthCodes)
		.where(
			and(eq(oauthCodes.grantId, grantId), isNull(oauthCodes.usedAt), gt(oauthCodes.expiresAt, at))
		)
		.get();
	if (code !== undefined) {
		return true;
	}
	return database
		.select()
		.from(oauthTokens)
		.where(
			and(
				eq(oauthTokens.grantId, grantId),
				isNull(oauthTokens.revokedAt),
				isNull(oauthTokens.usedAt),
				gt(oauthTokens.expiresAt, at)
			)
		)
		.all()
		.some((token) => token.idleExpiresAt === null || token.idleExpiresAt.getTime() > now);
}

/** Ends grants with nothing left that works (M9's 7 days idle and 30 days at most). */
function endRunOutGrants(database: Queryable, userId: string | undefined, now: number): void {
	for (const id of liveGrantIds(database, userId)) {
		if (!hasLiveCredential(database, id, now)) {
			endGrant(database, id, { reason: 'expired', actor: { kind: 'system' } }, now);
		}
	}
}

function toView(grant: GrantFacts, userName: string, now: number): GrantView {
	return {
		id: grant.id,
		assistant: grant.assistant,
		userName,
		createdIso: grant.createdAt.toISOString(),
		lastUsed:
			grant.lastUsedAt === null
				? { kind: 'never' }
				: { kind: 'used', atIso: grant.lastUsedAt.toISOString(), ip: grant.lastIp ?? '' },
		active: grant.lastUsedAt !== null && now - grant.lastUsedAt.getTime() <= CONNECTED_WINDOW_MS
	};
}

/** The Account page (one person's) or Settings → AI assistants (everyone's): live grants (M10). */
export function listGrants(
	database: AppDatabase,
	scope: { kind: 'user'; userId: string } | { kind: 'all' },
	now: number
): GrantView[] {
	const userId = scope.kind === 'user' ? scope.userId : undefined;
	database.transaction((transaction) => {
		endRunOutGrants(transaction, userId, now);
	});
	const names = new Map(
		database
			.select({ id: users.id, name: users.name })
			.from(users)
			.all()
			.map((row) => [row.id, row.name])
	);
	return liveGrantIds(database, userId).flatMap((id) => {
		const grant = findGrant(database, id);
		return grant === undefined ? [] : [toView(grant, names.get(grant.userId) ?? '', now)];
	});
}

/** The assistant this person used in the last 10 minutes, for the console header (M15). */
export function assistantStatus(database: Queryable, userId: string, now: number): AssistantStatus {
	const row = database
		.select({ id: oauthGrants.id })
		.from(oauthGrants)
		.where(
			and(
				eq(oauthGrants.userId, userId),
				isNull(oauthGrants.endedAt),
				gt(oauthGrants.lastUsedAt, new Date(now - CONNECTED_WINDOW_MS))
			)
		)
		.orderBy(desc(oauthGrants.lastUsedAt))
		.get();
	const grant = row === undefined ? undefined : findGrant(database, row.id);
	return grant === undefined
		? { kind: 'none' }
		: { kind: 'connected', name: assistantLabel(grant.assistant) };
}

export type Disconnect = { kind: 'ended' } | { kind: 'refused'; status: 404; message: string };

/**
 * Disconnect on the Account page (the person's own) or Settings → AI assistants (an admin, any
 * grant). Another person's grant looks missing to a member.
 */
export function disconnectGrant(
	database: AppDatabase,
	by: { userId: string; admin: boolean },
	grantId: string,
	now: number
): Disconnect {
	return database.transaction((transaction) => {
		const grant = findGrant(transaction, grantId);
		if (grant?.endedAt !== null || (!by.admin && grant.userId !== by.userId)) {
			return { kind: 'refused', status: 404, message: 'This assistant is not connected.' } as const;
		}
		endGrant(
			transaction,
			grantId,
			{ reason: 'disconnected', actor: { kind: 'user', userId: by.userId } },
			now
		);
		return { kind: 'ended' } as const;
	});
}

/** Saves Settings → AI assistants and ends grants that are no longer allowed (M1, M9). */
export function saveMcpSettings(
	database: AppDatabase,
	actorUserId: string,
	next: McpSettings,
	now: number
): McpSettingsChange {
	const change = writeMcpSettings(database, actorUserId, next, now);
	if (change.kind === 'changed') {
		endIneligibleGrants(database, now);
	}
	return change;
}

/** Every live grant ended by an admin, with one entry for the whole step. */
function endEveryGrant(database: AppDatabase, actorUserId: string, now: number): number {
	return database.transaction((transaction) => {
		const ids = liveGrantIds(transaction, undefined);
		let ended = 0;
		for (const id of ids) {
			if (
				endGrant(
					transaction,
					id,
					{ reason: 'kill-switch', actor: { kind: 'user', userId: actorUserId } },
					now
				)
			) {
				ended += 1;
			}
		}
		recordAudit(
			transaction,
			{
				actor: { kind: 'user', userId: actorUserId },
				kind: 'mcp-kill-switch',
				target: 'AI assistants',
				machineId: null,
				detail: { grantsEnded: String(ended) }
			},
			now
		);
		return ended;
	});
}

/** Stop all AI access (M14): MCP off, then every grant and token ended. Returns how many. */
export function stopAllAiAccess(database: AppDatabase, actorUserId: string, now: number): number {
	turnMcpOff(database, actorUserId, now);
	return endEveryGrant(database, actorUserId, now);
}
