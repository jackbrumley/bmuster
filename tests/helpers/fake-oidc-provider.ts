import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { CustomFetch } from 'openid-client';

/**
 * A tiny OpenID Connect provider on 127.0.0.1 for the sign-in tests: discovery,
 * JWKS and a token endpoint that checks the client secret, the code and the
 * PKCE verifier, and returns an RS256 ID token. The "user at the provider" is
 * played by the test: it reads the authorisation URL and calls `approve`.
 */
export type FakeProvider = {
	issuer: string;
	clientId: string;
	clientSecret: string;
	/** What the provider would do after the person signs in there: a code for the callback. */
	approve(
		authorizationUrl: URL,
		person: { subject: string; email: string | undefined; emailVerified: boolean; name: string },
		tamper: { kind: 'none' } | { kind: 'other-key' } | { kind: 'wrong-nonce' }
	): string;
	close(): Promise<void>;
};

type Grant = {
	challenge: string;
	redirectUri: string;
	idToken: string;
};

function base64url(value: Buffer | string): string {
	return Buffer.from(value).toString('base64url');
}

function jwt(claims: Record<string, unknown>, key: KeyObject, kid: string): string {
	const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid }));
	const payload = base64url(JSON.stringify(claims));
	const signature = sign('sha256', Buffer.from(`${header}.${payload}`), key);
	return `${header}.${payload}.${base64url(signature)}`;
}

export async function startFakeProvider(): Promise<FakeProvider> {
	const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
	const impostor = generateKeyPairSync('rsa', { modulusLength: 2048 });
	const kid = 'test-key';
	const clientId = 'bmuster-test-client';
	const clientSecret = 'fake-provider-secret';
	const grants = new Map<string, Grant>();
	let issuer = '';

	const server: Server = createServer((request, response) => {
		const url = new URL(request.url ?? '/', 'http://127.0.0.1');
		const json = (status: number, body: unknown): void => {
			response.writeHead(status, { 'content-type': 'application/json' });
			response.end(JSON.stringify(body));
		};
		if (url.pathname === '/.well-known/openid-configuration') {
			json(200, {
				issuer,
				authorization_endpoint: `${issuer}/authorize`,
				token_endpoint: `${issuer}/token`,
				jwks_uri: `${issuer}/jwks`,
				response_types_supported: ['code'],
				subject_types_supported: ['public'],
				id_token_signing_alg_values_supported: ['RS256'],
				code_challenge_methods_supported: ['S256']
			});
			return;
		}
		if (url.pathname === '/jwks') {
			json(200, {
				keys: [{ ...keys.publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }]
			});
			return;
		}
		if (url.pathname === '/token' && request.method === 'POST') {
			let body = '';
			request.on('data', (chunk: Buffer) => {
				body += chunk.toString('utf8');
			});
			request.on('end', () => {
				const form = new URLSearchParams(body);
				const basic = request.headers.authorization;
				const expectedBasic = `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString('base64')}`;
				const clientOk =
					basic === expectedBasic ||
					(form.get('client_id') === clientId && form.get('client_secret') === clientSecret);
				const grant = grants.get(form.get('code') ?? '');
				const verifier = form.get('code_verifier') ?? '';
				const challenge = base64url(createHash('sha256').update(verifier).digest());
				if (!clientOk) {
					json(401, { error: 'invalid_client' });
					return;
				}
				if (grant?.challenge !== challenge || grant.redirectUri !== form.get('redirect_uri')) {
					json(400, { error: 'invalid_grant' });
					return;
				}
				grants.delete(form.get('code') ?? '');
				json(200, {
					access_token: 'access',
					token_type: 'Bearer',
					expires_in: 300,
					id_token: grant.idToken
				});
			});
			return;
		}
		json(404, { error: 'not_found' });
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const address = server.address();
	if (address === null || typeof address === 'string')
		throw new Error('fake provider did not start');
	// The provider says it is https, as a real one must; the test's transport
	// (`fakeProviderFetch`) carries its requests over plain http to this server.
	issuer = `https://127.0.0.1:${(address satisfies AddressInfo).port}`;

	return {
		issuer,
		clientId,
		clientSecret,
		approve(authorizationUrl, person, tamper) {
			const params = authorizationUrl.searchParams;
			const nowSeconds = Math.floor(Date.now() / 1000);
			const claims: Record<string, unknown> = {
				iss: issuer,
				aud: clientId,
				sub: person.subject,
				iat: nowSeconds,
				exp: nowSeconds + 300,
				nonce: tamper.kind === 'wrong-nonce' ? 'not-the-nonce' : params.get('nonce'),
				name: person.name,
				email_verified: person.emailVerified
			};
			if (person.email !== undefined) claims['email'] = person.email;
			const code = crypto.randomUUID();
			grants.set(code, {
				challenge: params.get('code_challenge') ?? '',
				redirectUri: params.get('redirect_uri') ?? '',
				idToken: jwt(
					claims,
					tamper.kind === 'other-key' ? impostor.privateKey : keys.privateKey,
					kid
				)
			});
			return code;
		},
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error === undefined) resolve();
					else reject(error);
				});
			})
	};
}

/** openid-client's transport for the fake provider: its https URLs, sent over http. */
export const fakeProviderFetch: CustomFetch = (url, options) => {
	// openid-client sends a form to the token endpoint and nothing to the others.
	if (options.body !== undefined && !(options.body instanceof URLSearchParams)) {
		throw new Error('The fake provider only takes form bodies');
	}
	return fetch(url.replace(/^https:/, 'http:'), {
		method: options.method,
		headers: options.headers,
		body: options.body ?? null,
		redirect: options.redirect,
		signal: options.signal ?? null
	});
};
