import * as oidc from 'openid-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDatabase } from '#tests/helpers/fake-agent.ts';
import {
	fakeProviderFetch,
	startFakeProvider,
	type FakeProvider
} from '#tests/helpers/fake-oidc-provider.ts';
import { addTestUser, CLIENT, NOW, PASSWORD } from '#tests/helpers/people.ts';
import { turnOnTwoFactor } from '#tests/helpers/two-factor.ts';
import type { AppDatabase } from '../../database/connection.ts';
import { userIdentities, users } from '../../database/schema.ts';
import { addProvider } from './identity-providers.ts';
import {
	completeOidcSignIn,
	startOidcSignIn,
	type Discover,
	type OidcSignIn
} from './oidc-sign-in.ts';
import { findSession } from './sessions.ts';
import { updateSettingAsSystem } from '../settings/settings.ts';

/**
 * S10 against a real (local) provider: discovery, the authorisation URL, the
 * token request with PKCE and the ID token check all run for real. The only
 * test-specific piece is `discover`, whose transport reaches the provider's
 * https URLs over plain http on 127.0.0.1.
 */
const KEY = Buffer.alloc(32, 8);
const ORIGIN = 'https://bmuster.test';

const discover: Discover = (provider) =>
	oidc.discovery(new URL(provider.issuer), provider.clientId, provider.clientSecret, undefined, {
		[oidc.customFetch]: fakeProviderFetch
	});

let fake: FakeProvider;
beforeAll(async () => {
	fake = await startFakeProvider();
});
afterAll(async () => {
	await fake.close();
});

async function setUp(
	newPeople: 'invited' | 'auto-create'
): Promise<{ database: AppDatabase; providerId: string }> {
	const database = testDatabase();
	const admin = await addTestUser(database, {
		email: 'admin@example.com',
		role: 'admin',
		password: null
	});
	const provider = addProvider(
		database,
		admin.id,
		{
			name: 'Authentik',
			kind: 'authentik',
			issuer: fake.issuer,
			clientId: fake.clientId,
			clientSecret: fake.clientSecret,
			scopes: ['openid', 'email', 'profile'],
			newPeople,
			enabled: true
		},
		KEY,
		NOW
	);
	return { database, providerId: provider.id };
}

type Person = { subject: string; email: string | undefined; emailVerified: boolean; name: string };
const PRIYA: Person = {
	subject: 'priya-sub',
	email: 'Priya@Example.com',
	emailVerified: true,
	name: 'Priya N'
};

/** Start → the provider approves → callback, as a browser would go through it. */
async function signIn(
	database: AppDatabase,
	providerId: string,
	person: Person,
	options: {
		tamper: Parameters<FakeProvider['approve']>[2];
		state: 'kept' | 'changed';
		cookie: 'kept' | 'lost';
	} = { tamper: { kind: 'none' }, state: 'kept', cookie: 'kept' }
): Promise<{ result: OidcSignIn; authorizationUrl: URL }> {
	const started = await startOidcSignIn(
		database,
		providerId,
		{
			secretsKey: KEY,
			redirectUri: `${ORIGIN}/auth/oidc/${providerId}/callback`,
			returnTo: '/users',
			discover
		},
		Date.now()
	);
	if (started.kind !== 'redirect') throw new Error(started.message);
	const code = fake.approve(started.authorizationUrl, person, options.tamper);
	const callback = new URL(`${ORIGIN}/auth/oidc/${providerId}/callback`);
	callback.searchParams.set('code', code);
	callback.searchParams.set(
		'state',
		options.state === 'kept' ? (started.authorizationUrl.searchParams.get('state') ?? '') : 'forged'
	);
	callback.searchParams.set('iss', fake.issuer);
	const result = await completeOidcSignIn(
		database,
		providerId,
		{
			secretsKey: KEY,
			currentUrl: callback,
			flowCookie: options.cookie === 'kept' ? started.flowCookie : undefined,
			discover,
			client: CLIENT
		},
		Date.now()
	);
	return { result, authorizationUrl: started.authorizationUrl };
}

describe('OpenID Connect sign-in (S10)', () => {
	it('sends the browser with PKCE (S256), state and nonce, and keeps the verifier out of the URL', async () => {
		const { database, providerId } = await setUp('invited');
		const started = await startOidcSignIn(
			database,
			providerId,
			{ secretsKey: KEY, redirectUri: `${ORIGIN}/cb`, returnTo: '/', discover },
			NOW
		);
		if (started.kind !== 'redirect') throw new Error(started.message);
		const params = started.authorizationUrl.searchParams;
		expect(started.authorizationUrl.origin).toBe(fake.issuer);
		expect(params.get('response_type')).toBe('code');
		expect(params.get('code_challenge_method')).toBe('S256');
		expect(params.get('code_challenge')).toMatch(/^[\w-]{43}$/);
		expect(params.get('state')).not.toBeNull();
		expect(params.get('nonce')).not.toBeNull();
		expect(params.get('scope')).toBe('openid email profile');
		// The flow cookie is sealed: none of it is readable.
		expect(started.flowCookie).not.toContain(params.get('state') ?? 'x');
	});

	it('links an invited person by email on first sign-in, then by subject', async () => {
		const { database, providerId } = await setUp('invited');
		const invited = await addTestUser(database, {
			email: 'priya@example.com',
			role: 'member',
			password: null
		});
		const first = (await signIn(database, providerId, PRIYA)).result;
		if (first.kind !== 'signed-in') throw new Error(first.message);
		expect(first.user.id).toBe(invited.id);
		expect(first.returnTo).toBe('/users');
		expect(findSession(database, first.session.token, Date.now())).toMatchObject({
			userId: invited.id
		});
		expect(database.select().from(userIdentities).all()).toMatchObject([
			{ userId: invited.id, subject: 'priya-sub' }
		]);

		// The provider's email changes; the subject still finds her.
		const second = (await signIn(database, providerId, { ...PRIYA, email: 'priya.n@example.com' }))
			.result;
		expect(second).toMatchObject({ kind: 'signed-in', user: { id: invited.id } });
	});

	it('never asks for a two-factor code: the provider handles it (SPEC-TWO-FACTOR TF8)', async () => {
		const { database, providerId } = await setUp('invited');
		const invited = await addTestUser(database, {
			email: 'priya@example.com',
			role: 'admin',
			password: PASSWORD
		});
		await turnOnTwoFactor(database, invited, NOW);
		updateSettingAsSystem(database, 'twoFactorSignIn', 'everyone', 'test', NOW);
		const { result } = await signIn(database, providerId, PRIYA);
		if (result.kind !== 'signed-in') throw new Error(result.message);
		expect(findSession(database, result.session.token, Date.now())).toMatchObject({
			userId: invited.id
		});
	});

	it('refuses someone not invited when the provider is invite-only', async () => {
		const { database, providerId } = await setUp('invited');
		expect((await signIn(database, providerId, PRIYA)).result).toMatchObject({
			kind: 'refused',
			reason: 'not-invited'
		});
		expect(database.select().from(users).all()).toHaveLength(1);
	});

	it('creates a member with no password in auto-create mode', async () => {
		const { database, providerId } = await setUp('auto-create');
		const { result } = await signIn(database, providerId, PRIYA);
		expect(result).toMatchObject({
			kind: 'signed-in',
			user: { role: 'member', email: 'priya@example.com', name: 'Priya N' }
		});
		const row = database
			.select()
			.from(users)
			.all()
			.find((user) => user.email === 'priya@example.com');
		expect(row?.passwordHash).toBeNull();
	});

	it('never links by an unverified email', async () => {
		const { database, providerId } = await setUp('invited');
		await addTestUser(database, { email: 'priya@example.com', role: 'admin', password: null });
		expect(
			(await signIn(database, providerId, { ...PRIYA, emailVerified: false })).result
		).toMatchObject({
			kind: 'refused',
			reason: 'no-verified-email'
		});
	});

	it('refuses an ID token not signed with the provider’s keys', async () => {
		const { database, providerId } = await setUp('auto-create');
		const { result } = await signIn(database, providerId, PRIYA, {
			tamper: { kind: 'other-key' },
			state: 'kept',
			cookie: 'kept'
		});
		expect(result).toMatchObject({ kind: 'refused' });
		expect(result.kind === 'refused' ? result.reason : '').toContain('token-check-failed');
	});

	it('refuses a wrong nonce, a forged state, or a missing flow cookie', async () => {
		const { database, providerId } = await setUp('auto-create');
		for (const options of [
			{ tamper: { kind: 'wrong-nonce' }, state: 'kept', cookie: 'kept' },
			{ tamper: { kind: 'none' }, state: 'changed', cookie: 'kept' },
			{ tamper: { kind: 'none' }, state: 'kept', cookie: 'lost' }
		] as const) {
			const { result } = await signIn(database, providerId, PRIYA, options);
			expect(result.kind, JSON.stringify(options)).toBe('refused');
		}
		expect(database.select().from(users).all()).toHaveLength(1);
	});
});
