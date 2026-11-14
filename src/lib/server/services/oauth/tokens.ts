import { createHash, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull, lt, or } from 'drizzle-orm';
import {
	assistantLabel,
	isMcpScope,
	type AssistantName,
	type McpScope
} from '#lib/domain/mcp/mcp.ts';
import type { ConsoleUser } from '#lib/domain/users/user.ts';
import { PKCE_VERIFIER, type TokenRequest } from '#lib/schemas/mcp/oauth.ts';
import { oauthClients, oauthCodes, oauthGrants, oauthTokens } from '../../database/schema.ts';
import type { AppDatabase, Queryable } from '../../database/connection.ts';
import { recordAudit } from '../audit/audit.ts';
import { findUserById, toConsoleUser } from '../users/users.ts';
import { checkClientSecret, presentedMethod, type PresentedSecret } from './client-auth.ts';
import { endGrant, findGrant, LIFETIMES, viaDetail, type EndReason } from './grants.ts';
import { connectEligibility } from './mcp-settings.ts';
import { describeClient, oauthLog } from './oauth-log.ts';
import { hashSecret, newSecret } from './secrets.ts';

/**
 * The token endpoint, revocation and the bearer check (SPEC-MCP M8, M9). Tokens are opaque
 * (`bmat_` access, `bmrt_` refresh) and stored only as SHA-256, so every request looks its token
 * up and a revoke works on the next one. Refresh tokens rotate on every use; a used one presented
 * again ends the whole grant. `invalid_grant` for anything bad, used or expired; `invalid_client`
 * when a confidential client's secret is missing or wrong (M33). Every outcome writes one server
 * log line with the precise reason (M31); the client is told only the generic one.
 */

type TokenError = {
	kind: 'error';
	status: 400 | 401;
	error:
		'invalid_grant' | 'invalid_request' | 'invalid_target' | 'invalid_scope' | 'invalid_client';
	description: string;
	/** The precise reason, for the server log only. */
	why: string;
};

export type TokenReply =
	| {
			kind: 'issued';
			body: {
				access_token: string;
				token_type: 'Bearer';
				expires_in: number;
				scope: string;
				refresh_token: string | undefined;
			};
	  }
	| TokenError;

function refused(error: TokenError['error'], description: string, why: string): TokenError {
	return { kind: 'error', status: 400, error, description, why };
}

const BAD_GRANT = 'The code or refresh token is not valid, was already used, or has expired.';

/** S256 (RFC 7636): base64url(SHA-256(verifier)) must equal the challenge, compared in constant time. */
export function pkceMatches(verifier: string, challenge: string): boolean {
	if (!PKCE_VERIFIER.test(verifier)) {
		return false;
	}
	const computed = Buffer.from(createHash('sha256').update(verifier, 'ascii').digest('base64url'));
	const expected = Buffer.from(challenge);
	return computed.length === expected.length && timingSafeEqual(computed, expected);
}

/** An access token, and a refresh token when the grant allows staying connected. */
function issue(
	database: Queryable,
	grant: { id: string; scopes: McpScope[] },
	family: { id: string; refreshExpiresAt: number },
	now: number
): TokenReply {
	const access = newSecret('bmat_');
	database
		.insert(oauthTokens)
		.values({
			hash: hashSecret(access),
			grantId: grant.id,
			kind: 'access',
			familyId: family.id,
			expiresAt: new Date(now + LIFETIMES.accessMs)
		})
		.run();
	let refresh: string | undefined;
	if (grant.scopes.includes('offline_access')) {
		refresh = newSecret('bmrt_');
		database
			.insert(oauthTokens)
			.values({
				hash: hashSecret(refresh),
				grantId: grant.id,
				kind: 'refresh',
				familyId: family.id,
				expiresAt: new Date(family.refreshExpiresAt),
				idleExpiresAt: new Date(Math.min(now + LIFETIMES.refreshIdleMs, family.refreshExpiresAt))
			})
			.run();
	}
	return {
		kind: 'issued',
		body: {
			access_token: access,
			token_type: 'Bearer',
			expires_in: Math.floor(LIFETIMES.accessMs / 1000),
			scope: grant.scopes.join(' '),
			refresh_token: refresh
		}
	};
}

/** Ends the grant (when it is still live) and answers `invalid_grant`. */
function endAndRefuse(
	database: Queryable,
	grantId: string,
	reason: EndReason,
	now: number
): TokenError {
	endGrant(database, grantId, { reason, actor: { kind: 'system' } }, now);
	return refused('invalid_grant', BAD_GRANT, `the grant was ended (${reason})`);
}

/** A code for a token pair (M8): single use, 60 s, same client, redirect, resource and PKCE verifier. */
function exchangeCode(
	database: Queryable,
	request: Extract<TokenRequest, { grant_type: 'authorization_code' }>,
	resource: string,
	now: number
): TokenReply {
	const hash = hashSecret(request.code);
	const code = database.select().from(oauthCodes).where(eq(oauthCodes.hash, hash)).get();
	if (code === undefined) {
		return refused('invalid_grant', BAD_GRANT, 'the code is unknown');
	}
	const grant = findGrant(database, code.grantId);
	if (grant?.clientId !== request.client_id) {
		return refused('invalid_grant', BAD_GRANT, 'the code was issued to another client');
	}
	if (code.usedAt !== null) {
		// A code seen twice may have been stolen: whatever it already bought stops working.
		return endAndRefuse(database, grant.id, 'code-reuse', now);
	}
	database
		.update(oauthCodes)
		.set({ usedAt: new Date(now) })
		.where(eq(oauthCodes.hash, hash))
		.run();
	const problem =
		code.expiresAt.getTime() <= now
			? 'the code expired (codes last 60 seconds)'
			: grant.endedAt !== null
				? 'the grant has ended'
				: code.redirectUri !== request.redirect_uri
					? `the redirect_uri differs from the authorisation request's (${code.redirectUri})`
					: !pkceMatches(request.code_verifier, code.codeChallenge)
						? 'the PKCE code_verifier does not match the code_challenge'
						: undefined;
	if (problem !== undefined) {
		return refused('invalid_grant', BAD_GRANT, problem);
	}
	if (request.resource !== undefined && request.resource !== code.resource) {
		return refused(
			'invalid_target',
			`This server's resource is ${resource}.`,
			`the resource ${request.resource} differs from ${code.resource}`
		);
	}
	const eligibility = connectEligibility(database, grant.userId);
	if (eligibility.kind === 'ineligible') {
		return endAndRefuse(database, grant.id, eligibility.why, now);
	}
	return issue(
		database,
		grant,
		{ id: crypto.randomUUID(), refreshExpiresAt: now + LIFETIMES.refreshMaxMs },
		now
	);
}

/** Records a refused refresh for a known grant (the brief's "audit every refresh failure"). */
function auditRefusedRefresh(
	database: Queryable,
	grant: { userId: string; assistant: AssistantName; clientId: string },
	reason: string,
	now: number
): void {
	recordAudit(
		database,
		{
			actor: { kind: 'user', userId: grant.userId },
			kind: 'mcp-refresh-refused',
			target: assistantLabel(grant.assistant),
			machineId: null,
			detail: { ...viaDetail(grant.assistant, grant.clientId), reason }
		},
		now
	);
}

/** A refresh token for a new pair (M9): rotated on every use, 7 days idle, 30 days at most. */
function refresh(
	database: Queryable,
	request: Extract<TokenRequest, { grant_type: 'refresh_token' }>,
	resource: string,
	now: number
): TokenReply {
	const hash = hashSecret(request.refresh_token);
	const token = database.select().from(oauthTokens).where(eq(oauthTokens.hash, hash)).get();
	if (token?.kind !== 'refresh') {
		return refused('invalid_grant', BAD_GRANT, 'the refresh token is unknown');
	}
	const grant = findGrant(database, token.grantId);
	if (grant === undefined) {
		return refused('invalid_grant', BAD_GRANT, 'the refresh token has no grant');
	}
	if (grant.clientId !== request.client_id) {
		auditRefusedRefresh(database, grant, 'wrong-client', now);
		return refused('invalid_grant', BAD_GRANT, 'the refresh token belongs to another client');
	}
	if (grant.endedAt !== null) {
		auditRefusedRefresh(database, grant, 'grant-ended', now);
		return refused('invalid_grant', BAD_GRANT, 'the grant has ended');
	}
	if (token.usedAt !== null || token.revokedAt !== null) {
		return endAndRefuse(database, grant.id, 'refresh-reuse', now);
	}
	if (
		token.expiresAt.getTime() <= now ||
		(token.idleExpiresAt !== null && token.idleExpiresAt.getTime() <= now)
	) {
		auditRefusedRefresh(database, grant, 'expired', now);
		return endAndRefuse(database, grant.id, 'expired', now);
	}
	const eligibility = connectEligibility(database, grant.userId);
	if (eligibility.kind === 'ineligible') {
		return endAndRefuse(database, grant.id, eligibility.why, now);
	}
	if (request.resource !== undefined && request.resource !== resource) {
		return refused(
			'invalid_target',
			`This server's resource is ${resource}.`,
			`the resource ${request.resource} is not ${resource}`
		);
	}
	if (
		request.scope !== undefined &&
		!request.scope
			.split(' ')
			.filter((scope) => scope !== '')
			.every((scope) => isMcpScope(scope) && grant.scopes.includes(scope))
	) {
		return refused(
			'invalid_scope',
			'A refresh cannot add scopes.',
			`it asked for ${request.scope}`
		);
	}
	const used = database
		.update(oauthTokens)
		.set({ usedAt: new Date(now) })
		.where(and(eq(oauthTokens.hash, hash), isNull(oauthTokens.usedAt)))
		.run();
	if (used.changes !== 1) {
		return endAndRefuse(database, grant.id, 'refresh-reuse', now);
	}
	return issue(
		database,
		grant,
		{ id: token.familyId, refreshExpiresAt: token.expiresAt.getTime() },
		now
	);
}

/**
 * `/oauth/token`: the client's secret first (M33), then both grants in one transaction, so two
 * racing uses settle on one outcome. The outcome is logged after the transaction.
 */
export function tokenRequest(
	database: AppDatabase,
	request: TokenRequest,
	secret: PresentedSecret,
	resource: string,
	now: number
): TokenReply {
	const client = checkClientSecret(database, request.client_id, secret);
	const reply: TokenReply =
		client.kind === 'refused'
			? {
					kind: 'error',
					status: 401,
					error: 'invalid_client',
					description: 'Client authentication failed.',
					why: client.why
				}
			: database.transaction((transaction) => {
					pruneDeadCredentials(transaction, now);
					switch (request.grant_type) {
						case 'authorization_code':
							return exchangeCode(transaction, request, resource, now);
						case 'refresh_token':
							return refresh(transaction, request, resource, now);
					}
				});
	const facts = {
		client: describeClient(database, request.client_id),
		redirectUri: request.grant_type === 'authorization_code' ? request.redirect_uri : null,
		authMethod: presentedMethod(secret)
	};
	switch (reply.kind) {
		case 'issued':
			oauthLog(
				'info',
				'token',
				`issued tokens (${request.grant_type}, scope ${reply.body.scope})`,
				facts,
				now
			);
			break;
		case 'error':
			oauthLog(
				'info',
				'token',
				`refused (${reply.error}) grant_type ${request.grant_type}: ${reply.why}`,
				facts,
				now
			);
			break;
	}
	return reply;
}

export type RevokeOutcome = { kind: 'answered' } | { kind: 'refused'; why: string };

/** Whether a client must send its secret: one registered with `client_secret_*` (M33). */
function isConfidential(database: Queryable, clientId: string): boolean {
	const row = database
		.select({ method: oauthClients.tokenEndpointAuthMethod })
		.from(oauthClients)
		.where(eq(oauthClients.clientId, clientId))
		.get();
	return row !== undefined && row.method !== 'none';
}

/** What a revoke did, for the log; nothing here is told to the client. */
function revokeInTransaction(
	transaction: Queryable,
	revoke: { token: string; clientId: string | undefined },
	now: number
): string {
	const token = transaction
		.select()
		.from(oauthTokens)
		.where(eq(oauthTokens.hash, hashSecret(revoke.token)))
		.get();
	const grant = token === undefined ? undefined : findGrant(transaction, token.grantId);
	if (token === undefined || grant === undefined) {
		return 'ignored: the token is unknown';
	}
	if (revoke.clientId !== undefined && revoke.clientId !== grant.clientId) {
		return "ignored: the token is another client's";
	}
	if (revoke.clientId === undefined && isConfidential(transaction, grant.clientId)) {
		return 'ignored: the token belongs to a confidential client, which did not authenticate';
	}
	switch (token.kind) {
		case 'refresh':
			endGrant(
				transaction,
				grant.id,
				{ reason: 'disconnected', actor: { kind: 'user', userId: grant.userId } },
				now
			);
			return 'ended the grant (refresh token revoked)';
		case 'access':
			transaction
				.update(oauthTokens)
				.set({ revokedAt: new Date(now) })
				.where(eq(oauthTokens.hash, token.hash))
				.run();
			return 'revoked the access token';
	}
}

/**
 * `/oauth/revoke` (RFC 7009): answered 200 whether or not the token was known, unless client
 * authentication fails (401 `invalid_client`). Revoking a refresh token disconnects the whole
 * grant; an access token stops on its own. A token named with another client's id is left, and
 * so is a confidential client's token sent without its id and secret.
 */
export function revokeToken(
	database: AppDatabase,
	revoke: { token: string; clientId: string | undefined; secret: PresentedSecret },
	now: number
): RevokeOutcome {
	const facts = {
		client: revoke.clientId === undefined ? null : describeClient(database, revoke.clientId),
		redirectUri: null,
		authMethod: presentedMethod(revoke.secret)
	};
	const check =
		revoke.clientId === undefined
			? revoke.secret.kind === 'none'
				? ({ kind: 'accepted' } as const)
				: ({ kind: 'refused', why: 'a client secret came without a client_id' } as const)
			: checkClientSecret(database, revoke.clientId, revoke.secret);
	if (check.kind === 'refused') {
		oauthLog('info', 'revoke', `refused (invalid_client): ${check.why}`, facts, now);
		return check;
	}
	const done = database.transaction((transaction) => revokeInTransaction(transaction, revoke, now));
	oauthLog('info', 'revoke', done, facts, now);
	return { kind: 'answered' };
}

/** Who an assistant's request acts as (M4, M13): the person, the grant, and the assistant. */
export type McpPrincipal = {
	user: ConsoleUser;
	grantId: string;
	scopes: McpScope[];
	assistant: AssistantName;
	clientId: string;
};

export type AccessCheck =
	| { kind: 'valid'; principal: McpPrincipal }
	| { kind: 'invalid'; why: string; client: string | null };

/** The grant's last use is written at most this often (and whenever the address changes). */
const TOUCH_EVERY_MS = 60_000;

/**
 * The bearer check on every `/mcp` request: the token is live, its grant is live, and the person
 * may still connect. A person who may not ends the grant here too, in case nothing else did.
 */
export function authenticateAccessToken(
	database: AppDatabase,
	token: string,
	client: { ip: string; userAgent: string },
	now: number
): AccessCheck {
	if (!token.startsWith('bmat_')) {
		return { kind: 'invalid', why: 'the bearer token is not a BMuster access token', client: null };
	}
	return database.transaction((transaction) => {
		const row = transaction
			.select()
			.from(oauthTokens)
			.where(eq(oauthTokens.hash, hashSecret(token)))
			.get();
		if (row?.kind !== 'access') {
			return { kind: 'invalid', why: 'the access token is unknown', client: null } as const;
		}
		const grant = findGrant(transaction, row.grantId);
		if (grant === undefined) {
			return { kind: 'invalid', why: 'the access token has no grant', client: null } as const;
		}
		const label = `${grant.assistant.name} (${grant.clientId})`;
		const problem =
			row.revokedAt !== null
				? 'the access token was revoked'
				: row.expiresAt.getTime() <= now
					? 'the access token expired (they last an hour; the client should refresh)'
					: grant.endedAt !== null
						? 'the grant has ended (disconnected, or the person may no longer connect)'
						: undefined;
		if (problem !== undefined) {
			return { kind: 'invalid', why: problem, client: label } as const;
		}
		const eligibility = connectEligibility(transaction, grant.userId);
		const user = findUserById(transaction, grant.userId);
		if (eligibility.kind === 'ineligible' || user === undefined) {
			endGrant(
				transaction,
				grant.id,
				{
					reason: eligibility.kind === 'ineligible' ? eligibility.why : 'user-disabled',
					actor: { kind: 'system' }
				},
				now
			);
			return {
				kind: 'invalid',
				why: 'the person may no longer connect, so the grant was ended',
				client: label
			} as const;
		}
		if (
			grant.lastUsedAt === null ||
			now - grant.lastUsedAt.getTime() >= TOUCH_EVERY_MS ||
			grant.lastIp !== client.ip
		) {
			transaction
				.update(oauthGrants)
				.set({
					lastUsedAt: new Date(now),
					lastIp: client.ip,
					lastUserAgent: client.userAgent.slice(0, 300)
				})
				.where(eq(oauthGrants.id, grant.id))
				.run();
		}
		return {
			kind: 'valid',
			principal: {
				user: toConsoleUser(user),
				grantId: grant.id,
				scopes: grant.scopes,
				assistant: grant.assistant,
				clientId: grant.clientId
			}
		} as const;
	});
}

/** Codes and tokens a day past their end are deleted; the grant rows keep the record. */
function pruneDeadCredentials(database: Queryable, now: number): void {
	const dayAgo = new Date(now - 24 * 60 * 60_000);
	database.delete(oauthCodes).where(lt(oauthCodes.expiresAt, dayAgo)).run();
	database
		.delete(oauthTokens)
		.where(or(lt(oauthTokens.expiresAt, dayAgo), lt(oauthTokens.revokedAt, dayAgo)))
		.run();
}
