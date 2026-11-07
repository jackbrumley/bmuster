import * as oidc from 'openid-client';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { ConsoleUser } from '#lib/domain/users/user.ts';
import { userIdentities } from '../../database/schema.ts';
import type { AppDatabase, Queryable } from '../../database/connection.ts';
import { openSecret, sealSecret } from '../../crypto/secret-box.ts';
import { recordAudit } from '../audit/audit.ts';
import {
	findUserByEmail,
	findUserById,
	insertUser,
	markSignedIn,
	toConsoleUser
} from '../users/users.ts';
import type { SignInClient } from './client.ts';
import { providerForSignIn, type ProviderForSignIn } from './identity-providers.ts';
import { pruneSessions, startSession, type StartedSession } from './sessions.ts';

/**
 * "Continue with <provider>" (SPEC-SIGN-IN S10): the authorisation code flow
 * with PKCE, `state` and `nonce`. openid-client checks the ID token's
 * issuer, audience, expiry and nonce, and (switched on below) its signature
 * against the provider's JWKS. The verifier, state and nonce travel in a 10-minute HttpOnly cookie,
 * sealed with SECRETS_KEY so it can be neither read nor forged.
 *
 * A person is found by (provider, subject); failing that, an existing user
 * with the same (verified) email is linked on first sign-in (an invite);
 * failing that, the provider's new-people mode decides.
 */
export const FLOW_COOKIE = 'bmuster_oidc';
export const FLOW_COOKIE_PATH = '/auth/oidc/';
export const FLOW_MAX_AGE_SECONDS = 10 * 60;

/** Finds the provider's endpoints and keys. Tests pass one that allows a local http issuer. */
export type Discover = (provider: ProviderForSignIn) => Promise<oidc.Configuration>;

export const discoverProvider: Discover = (provider) =>
	oidc.discovery(new URL(provider.issuer), provider.clientId, provider.clientSecret);

const flowSchema = z.object({
	providerId: z.string(),
	verifier: z.string(),
	state: z.string(),
	nonce: z.string(),
	returnTo: z.string(),
	expiresAtMs: z.number()
});

export type OidcStart =
	| { kind: 'redirect'; authorizationUrl: URL; flowCookie: string }
	| { kind: 'refused'; message: string };

const UNAVAILABLE = 'That sign-in option is not available. Use another, or ask an admin.';
const FAILED = 'Sign-in with that provider did not work. Try again, or ask an admin.';

export async function startOidcSignIn(
	database: Queryable,
	providerId: string,
	options: { secretsKey: Buffer; redirectUri: string; returnTo: string; discover: Discover },
	now: number
): Promise<OidcStart> {
	const provider = providerForSignIn(database, providerId, options.secretsKey);
	if (provider?.enabled !== true) {
		return { kind: 'refused', message: UNAVAILABLE };
	}
	let config: oidc.Configuration;
	try {
		config = await options.discover(provider);
	} catch {
		return {
			kind: 'refused',
			message: `BMuster could not reach ${provider.name}. Try again shortly, or ask an admin.`
		};
	}
	const verifier = oidc.randomPKCECodeVerifier();
	const flow: z.infer<typeof flowSchema> = {
		providerId: provider.id,
		verifier,
		state: oidc.randomState(),
		nonce: oidc.randomNonce(),
		returnTo: options.returnTo,
		expiresAtMs: now + FLOW_MAX_AGE_SECONDS * 1000
	};
	const authorizationUrl = oidc.buildAuthorizationUrl(config, {
		redirect_uri: options.redirectUri,
		scope: provider.scopes.join(' '),
		code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
		code_challenge_method: 'S256',
		state: flow.state,
		nonce: flow.nonce
	});
	const flowCookie = sealSecret(Buffer.from(JSON.stringify(flow), 'utf8'), options.secretsKey);
	return { kind: 'redirect', authorizationUrl, flowCookie };
}

export type OidcSignIn =
	| {
			kind: 'signed-in';
			user: ConsoleUser;
			session: StartedSession;
			returnTo: string;
	  }
	| { kind: 'refused'; message: string; reason: string };

type Claims = { subject: string; email: string | undefined; name: string | undefined };

export async function completeOidcSignIn(
	database: AppDatabase,
	providerId: string,
	options: {
		secretsKey: Buffer;
		/** The callback URL exactly as the provider sent the browser to it. */
		currentUrl: URL;
		flowCookie: string | undefined;
		discover: Discover;
		client: SignInClient;
	},
	now: number
): Promise<OidcSignIn> {
	const provider = providerForSignIn(database, providerId, options.secretsKey);
	if (provider?.enabled !== true) {
		return { kind: 'refused', message: UNAVAILABLE, reason: 'provider-unavailable' };
	}
	const refuse = (reason: string, message: string, target: string): OidcSignIn => {
		recordAudit(
			database,
			{
				actor: { kind: 'system' },
				kind: 'sign-in-failed',
				target,
				machineId: null,
				detail: { method: provider.name, reason, ip: options.client.ip }
			},
			now
		);
		return { kind: 'refused', message, reason };
	};

	const flow = openFlow(options.flowCookie, options.secretsKey);
	if (flow?.providerId !== provider.id || flow.expiresAtMs <= now) {
		return refuse(
			'flow-missing-or-expired',
			'That sign-in took too long or was started elsewhere. Try again.',
			provider.name
		);
	}

	let claims: Claims;
	try {
		const config = await options.discover(provider);
		// openid-client trusts an ID token from the token endpoint without checking
		// its signature (OIDC Core 3.1.3.7 allows that over TLS). SPEC-SIGN-IN S10
		// checks it against the provider's JWKS anyway.
		oidc.enableNonRepudiationChecks(config);
		const tokens = await oidc.authorizationCodeGrant(config, options.currentUrl, {
			pkceCodeVerifier: flow.verifier,
			expectedState: flow.state,
			expectedNonce: flow.nonce,
			idTokenExpected: true
		});
		const idToken = tokens.claims();
		if (idToken === undefined) {
			return refuse('no-id-token', FAILED, provider.name);
		}
		claims = {
			subject: idToken.sub,
			email: verifiedEmail(idToken),
			name: typeof idToken['name'] === 'string' ? idToken['name'] : undefined
		};
	} catch (error) {
		return refuse(`token-check-failed: ${errorText(error)}`, FAILED, provider.name);
	}

	const resolved = resolveUser(database, provider, claims, now);
	if (resolved.kind === 'refused') {
		return refuse(resolved.reason, resolved.message, claims.email ?? claims.subject);
	}
	const user = resolved.user;
	const session = database.transaction((transaction) => {
		pruneSessions(transaction, now);
		markSignedIn(transaction, user.id, now);
		recordAudit(
			transaction,
			{
				actor: { kind: 'user', userId: user.id },
				kind: 'sign-in',
				target: user.email,
				machineId: null,
				detail: { method: provider.name, ip: options.client.ip }
			},
			now
		);
		return startSession(transaction, user.id, options.client, now);
	});
	return { kind: 'signed-in', user, session, returnTo: flow.returnTo };
}

function openFlow(
	cookie: string | undefined,
	secretsKey: Buffer
): z.infer<typeof flowSchema> | undefined {
	if (cookie === undefined) {
		return undefined;
	}
	try {
		return flowSchema.parse(JSON.parse(openSecret(cookie, secretsKey).toString('utf8')));
	} catch {
		return undefined;
	}
}

/** The email, unless the provider says it is unverified. Lower case. */
function verifiedEmail(idToken: oidc.IDToken): string | undefined {
	const email = idToken['email'];
	if (typeof email !== 'string' || idToken['email_verified'] === false) {
		return undefined;
	}
	return email.trim().toLowerCase();
}

function errorText(error: unknown): string {
	return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

type Resolved =
	{ kind: 'user'; user: ConsoleUser } | { kind: 'refused'; reason: string; message: string };

const NOT_INVITED =
	'You do not have an account on this BMuster server yet. Ask an admin to add you.';
const DISABLED = 'Your account on this BMuster server is turned off. Ask an admin.';

function resolveUser(
	database: AppDatabase,
	provider: ProviderForSignIn,
	claims: Claims,
	now: number
): Resolved {
	return database.transaction((transaction): Resolved => {
		const linked = transaction
			.select({ userId: userIdentities.userId })
			.from(userIdentities)
			.where(
				and(eq(userIdentities.providerId, provider.id), eq(userIdentities.subject, claims.subject))
			)
			.get();
		if (linked !== undefined) {
			const user = findUserById(transaction, linked.userId);
			if (user?.disabledAt !== null) {
				return { kind: 'refused', reason: 'disabled', message: DISABLED };
			}
			return { kind: 'user', user: toConsoleUser(user) };
		}

		if (claims.email === undefined) {
			return { kind: 'refused', reason: 'no-verified-email', message: NOT_INVITED };
		}
		const invited = findUserByEmail(transaction, claims.email);
		if (invited !== undefined) {
			if (invited.disabledAt !== null) {
				return { kind: 'refused', reason: 'disabled', message: DISABLED };
			}
			if (hasIdentityAt(transaction, invited.id, provider.id)) {
				// Already linked to another account at this provider: never relink by email.
				return { kind: 'refused', reason: 'email-linked-to-another-subject', message: NOT_INVITED };
			}
			link(transaction, invited.id, provider.id, claims.subject);
			return { kind: 'user', user: toConsoleUser(invited) };
		}

		switch (provider.newPeople) {
			case 'invited':
				return { kind: 'refused', reason: 'not-invited', message: NOT_INVITED };
			case 'auto-create': {
				const created = insertUser(
					transaction,
					{
						name: claims.name ?? claims.email,
						email: claims.email,
						role: 'member',
						passwordHash: null
					},
					now
				);
				link(transaction, created.id, provider.id, claims.subject);
				recordAudit(
					transaction,
					{
						actor: { kind: 'system' },
						kind: 'user-added',
						target: created.email,
						machineId: null,
						detail: { role: 'member', provider: provider.name, password: 'none' }
					},
					now
				);
				return { kind: 'user', user: toConsoleUser(created) };
			}
		}
	});
}

function hasIdentityAt(database: Queryable, userId: string, providerId: string): boolean {
	return (
		database
			.select({ id: userIdentities.id })
			.from(userIdentities)
			.where(and(eq(userIdentities.userId, userId), eq(userIdentities.providerId, providerId)))
			.get() !== undefined
	);
}

function link(database: Queryable, userId: string, providerId: string, subject: string): void {
	database
		.insert(userIdentities)
		.values({ id: crypto.randomUUID(), userId, providerId, subject })
		.run();
}
