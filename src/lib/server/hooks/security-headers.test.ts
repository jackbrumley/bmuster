import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { RequestEvent } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';
import { registerServedCertificate } from '../tls/served-certificate.ts';
import { CSP_DIRECTIVES, INLINE_SCRIPT_HASHES } from './content-security-policy.ts';
import { FORM_ACTION_HEADER, securityHeadersFor } from './security-headers.ts';

const SELF = 'https://bmuster.test';

/** What SvelteKit sends on a page it renders: its policy, with this response's nonce. */
const PAGE_POLICY =
	"default-src 'self'; script-src 'self' 'nonce-abc123'; form-action 'self'; frame-ancestors 'none'";

type Transport =
	{ kind: 'own-certificate' } | { kind: 'plain'; protocolHeader: string | undefined };

function event(path: string, headers: Record<string, string> = {}): RequestEvent {
	const partial: Pick<RequestEvent, 'request' | 'url'> = {
		request: new Request(`${SELF}${path}`, { headers }),
		url: new URL(`${SELF}${path}`)
	};
	return partial as RequestEvent;
}

async function reply(
	transport: Transport,
	path: string,
	response: () => Response,
	headers: Record<string, string> = {}
): Promise<Headers> {
	registerServedCertificate(
		transport.kind === 'own-certificate'
			? { kind: 'own', certificatePem: 'cert', privateKeyPem: 'key' }
			: { kind: 'plain' }
	);
	const protocolHeader = transport.kind === 'plain' ? transport.protocolHeader : undefined;
	const handle = securityHeadersFor(protocolHeader);
	const result = await handle({
		event: event(path, headers),
		resolve: () => Promise.resolve(response())
	});
	return result.headers;
}

const page = (): Response =>
	new Response('<!doctype html><title>Machines</title>', {
		headers: { 'content-type': 'text/html', 'content-security-policy': PAGE_POLICY }
	});
const api = (): Response => Response.json({ machines: [] });
const errorPage = (): Response =>
	new Response('<!doctype html><title>BMuster cannot load right now</title>', {
		status: 500,
		headers: { 'content-type': 'text/html; charset=utf-8' }
	});

const PLAIN: Transport = { kind: 'plain', protocolHeader: undefined };

function expectBrowserHeaders(headers: Headers): void {
	expect(headers.get('x-frame-options')).toBe('DENY');
	expect(headers.get('x-content-type-options')).toBe('nosniff');
	expect(headers.get('referrer-policy')).toBe('same-origin');
	const permissions = headers.get('permissions-policy') ?? '';
	expect(permissions).toContain('camera=()');
	expect(permissions).toContain('microphone=()');
	expect(permissions).toContain('geolocation=()');
	expect(permissions).toContain('clipboard-read=(self)');
	expect(permissions).toContain('clipboard-write=(self)');
	expect(headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
}

describe('browser security headers (SPEC-SIGN-IN S20)', () => {
	it('S20: a page gets every header and keeps the policy SvelteKit wrote with its nonce', async () => {
		const headers = await reply(PLAIN, '/machines', page);
		expectBrowserHeaders(headers);
		expect(headers.get('content-security-policy')).toBe(PAGE_POLICY);
	});

	it('S20: an API reply gets every header, with the policy the pages use', async () => {
		const headers = await reply(PLAIN, '/api/machines', api);
		expectBrowserHeaders(headers);
		const policy = headers.get('content-security-policy') ?? '';
		expect(policy).toContain("default-src 'self'");
		expect(policy).toContain("object-src 'none'");
		expect(policy).toContain("form-action 'self'");
	});

	it('S20: the last-resort error page gets every header, and its theme script is allowed', async () => {
		const headers = await reply(PLAIN, '/machines', errorPage);
		expectBrowserHeaders(headers);
		expect(headers.get('content-security-policy')).toContain(`'${INLINE_SCRIPT_HASHES.error}'`);
	});

	it('S20: a redirect, whose headers cannot be changed, still gets them', async () => {
		const headers = await reply(PLAIN, '/old', () => Response.redirect(`${SELF}/login`, 303));
		expectBrowserHeaders(headers);
		expect(headers.get('location')).toBe(`${SELF}/login`);
	});

	it("S20: a route's own Referrer-Policy is kept (share links)", async () => {
		const headers = await reply(
			PLAIN,
			'/s/abc',
			() => new Response('<p>Shared</p>', { headers: { 'referrer-policy': 'no-referrer' } })
		);
		expect(headers.get('referrer-policy')).toBe('no-referrer');
	});

	it('S20: Strict-Transport-Security only when the request reached the server over HTTPS', async () => {
		const hsts = 'max-age=31536000';
		// Local network mode: the server's own certificate, so every request is HTTPS.
		expect(
			(await reply({ kind: 'own-certificate' }, '/', page)).get('strict-transport-security')
		).toBe(hsts);
		// Plain HTTP with no proxy named: adapter-node only guesses https, so no HSTS.
		expect((await reply(PLAIN, '/', page)).has('strict-transport-security')).toBe(false);
		const proxied: Transport = { kind: 'plain', protocolHeader: 'x-forwarded-proto' };
		expect(
			(await reply(proxied, '/', page, { 'x-forwarded-proto': 'https' })).get(
				'strict-transport-security'
			)
		).toBe(hsts);
		expect(
			(await reply(proxied, '/', page, { 'x-forwarded-proto': 'http' })).has(
				'strict-transport-security'
			)
		).toBe(false);
		expect((await reply(proxied, '/', page)).has('strict-transport-security')).toBe(false);
	});

	it("S20: a page may add one other site to form-action for its own response, and the note doesn't leave the server", async () => {
		const consent = (): Response =>
			new Response('<form method="POST" action="?/allow"></form>', {
				headers: {
					'content-type': 'text/html',
					'content-security-policy': PAGE_POLICY,
					[FORM_ACTION_HEADER]: 'http://127.0.0.1:33418'
				}
			});
		const headers = await reply(PLAIN, '/oauth/authorize', consent);
		expect(headers.get('content-security-policy')).toContain(
			"form-action 'self' http://127.0.0.1:33418;"
		);
		expect(headers.has(FORM_ACTION_HEADER)).toBe(false);

		const injected = (): Response =>
			new Response('', { headers: { [FORM_ACTION_HEADER]: 'https://a.example; script-src *' } });
		await expect(reply(PLAIN, '/oauth/authorize', injected)).rejects.toThrow(/origin/);
	});

	it("S20: the policy forbids framing, plugins and other sites' scripts", () => {
		expect(CSP_DIRECTIVES['frame-ancestors']).toEqual(['none']);
		expect(CSP_DIRECTIVES['object-src']).toEqual(['none']);
		expect(CSP_DIRECTIVES['default-src']).toEqual(['self']);
		expect(CSP_DIRECTIVES['base-uri']).toEqual(['self']);
		expect(CSP_DIRECTIVES['script-src']).not.toContain('unsafe-inline');
		const config = readFileSync(new URL('../../../../vite.config.ts', import.meta.url), 'utf8');
		expect(config).toContain("csp: { mode: 'auto', directives: CSP_DIRECTIVES }");
	});

	it('S20: the inline theme scripts in app.html and error.html match their allowed hashes', () => {
		const hashOf = (file: string): string => {
			const html = readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8');
			const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
			if (script === undefined) throw new Error(`${file} has no inline script`);
			return `sha256-${createHash('sha256').update(script).digest('base64')}`;
		};
		expect(hashOf('app.html'), 'update INLINE_SCRIPT_HASHES.app').toBe(INLINE_SCRIPT_HASHES.app);
		expect(hashOf('error.html'), 'update INLINE_SCRIPT_HASHES.error').toBe(
			INLINE_SCRIPT_HASHES.error
		);
	});
});
