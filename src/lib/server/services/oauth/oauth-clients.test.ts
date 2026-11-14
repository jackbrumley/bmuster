import { describe, expect, it } from 'vitest';
import { testDatabase } from '#tests/helpers/fake-agent.ts';
import { CLAUDE_CODE_DOCUMENT, CLAUDE_CODE_ID, documentServer } from '#tests/helpers/mcp.ts';
import { NOW } from '#tests/helpers/people.ts';
import { oauthGrants } from '../../database/schema.ts';
import {
	allowsRedirect,
	isMetadataDocumentUrl,
	redirectUriMatches,
	registerClient,
	resolveClient
} from './clients.ts';
import { registrationAllowed } from './registration-limits.ts';
import { isPublicAddress, safeFetchJson } from './safe-fetch.ts';

const DAY = 24 * 60 * 60_000;

describe('clients (SPEC-MCP M6)', () => {
	it('M6: an HTTPS client_id is a metadata document: fetched, verified by its host, cached a day', async () => {
		const database = testDatabase();
		const server = documentServer({ [CLAUDE_CODE_ID]: CLAUDE_CODE_DOCUMENT });
		const found = await resolveClient(database, CLAUDE_CODE_ID, server.fetchJson, NOW);
		expect(found).toMatchObject({
			kind: 'found',
			client: {
				assistant: { name: 'Claude Code', identity: { kind: 'verified', host: 'claude.ai' } }
			}
		});
		await resolveClient(database, CLAUDE_CODE_ID, server.fetchJson, NOW + DAY - 1);
		expect(server.fetched).toHaveLength(1);
		await resolveClient(database, CLAUDE_CODE_ID, server.fetchJson, NOW + DAY);
		expect(server.fetched).toHaveLength(2);
	});

	it('M6: a document must name itself, be a public client, and declare acceptable redirects', async () => {
		const database = testDatabase();
		const url = 'https://assistant.example/client.json';
		for (const document of [
			{ ...CLAUDE_CODE_DOCUMENT, client_id: 'https://other.example/client.json' },
			{
				...CLAUDE_CODE_DOCUMENT,
				client_id: url,
				token_endpoint_auth_method: 'client_secret_basic'
			},
			{ ...CLAUDE_CODE_DOCUMENT, client_id: url, redirect_uris: ['http://attacker.example/cb'] },
			{ client_id: url }
		]) {
			const server = documentServer({ [url]: document });
			expect((await resolveClient(database, url, server.fetchJson, NOW)).kind).toBe('unknown');
		}
	});

	it('M6: fails closed when the document cannot be fetched', async () => {
		const database = testDatabase();
		const lookup = await resolveClient(
			database,
			'https://gone.example/client.json',
			documentServer({}).fetchJson,
			NOW
		);
		expect(lookup).toMatchObject({ kind: 'unknown' });
	});

	it('M6: only HTTPS URLs with a path count as metadata documents', () => {
		expect(isMetadataDocumentUrl(CLAUDE_CODE_ID)).toBe(true);
		expect(isMetadataDocumentUrl('http://claude.ai/oauth/client')).toBe(false);
		expect(isMetadataDocumentUrl('https://claude.ai/')).toBe(false);
		expect(isMetadataDocumentUrl('https://user:pass@claude.ai/client')).toBe(false);
		expect(isMetadataDocumentUrl('https://claude.ai/client#x')).toBe(false);
	});

	it('M6: fetching refuses plain HTTP and addresses that are not public (SSRF)', async () => {
		for (const address of [
			'127.0.0.1',
			'10.1.2.3',
			'172.20.0.1',
			'192.168.1.1',
			'169.254.169.254',
			'100.64.0.1',
			'0.0.0.0',
			'::1',
			'fd00::1',
			'fe80::1',
			'::ffff:127.0.0.1',
			'::ffff:7f00:1'
		]) {
			expect(isPublicAddress(address), address).toBe(false);
		}
		expect(isPublicAddress('160.79.104.10')).toBe(true);
		expect(isPublicAddress('2606:4700::1111')).toBe(true);
		expect(await safeFetchJson('http://claude.ai/client')).toMatchObject({ kind: 'failed' });
		expect(await safeFetchJson('https://127.0.0.1/client')).toMatchObject({
			kind: 'failed',
			reason: 'The address is not on the public internet.'
		});
		expect(await safeFetchJson('https://[::1]/client')).toMatchObject({ kind: 'failed' });
		expect(await safeFetchJson('https://169.254.169.254/latest')).toMatchObject({
			kind: 'failed'
		});
	});

	it('M6: DCR makes an unverified public client and grants nothing', async () => {
		const database = testDatabase();
		const registered = registerClient(
			database,
			{ client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] },
			NOW
		);
		if (registered.kind !== 'registered') throw new Error(registered.message);
		expect(registered.reply.token_endpoint_auth_method).toBe('none');
		const lookup = await resolveClient(
			database,
			registered.reply.client_id,
			documentServer({}).fetchJson,
			NOW
		);
		expect(lookup).toMatchObject({
			kind: 'found',
			client: { assistant: { name: 'Claude', identity: { kind: 'unverified' } } }
		});
		expect(database.select().from(oauthGrants).all()).toEqual([]);
	});

	it('M6: DCR refuses auth methods BMuster does not offer, and unsafe redirects', () => {
		const database = testDatabase();
		for (const method of ['private_key_jwt', 'tls_client_auth', 'client_secret_jwt']) {
			expect(
				registerClient(
					database,
					{ redirect_uris: ['https://a.example/cb'], token_endpoint_auth_method: method },
					NOW
				)
			).toMatchObject({ kind: 'refused', error: 'invalid_client_metadata' });
		}
		for (const redirect of [
			'http://a.example/cb',
			'javascript:alert(1)',
			'https://a.example/cb#x'
		]) {
			expect(registerClient(database, { redirect_uris: [redirect] }, NOW)).toMatchObject({
				kind: 'refused',
				error: 'invalid_redirect_uri'
			});
		}
		expect(registerClient(database, {}, NOW)).toMatchObject({ kind: 'refused' });
	});

	it('M6: DCR is rate-limited per address', () => {
		const address = '203.0.113.77';
		for (let attempt = 0; attempt < 10; attempt += 1) {
			expect(registrationAllowed(address, NOW + attempt)).toBe(true);
		}
		expect(registrationAllowed(address, NOW + 10)).toBe(false);
		expect(registrationAllowed('203.0.113.78', NOW + 10)).toBe(true);
		expect(registrationAllowed(address, NOW + 60 * 60_000 + 1)).toBe(true);
	});

	it('M6: redirect URIs match exactly, except loopback on any port', () => {
		expect(
			redirectUriMatches(
				'https://claude.ai/api/mcp/auth_callback',
				'https://claude.ai/api/mcp/auth_callback'
			)
		).toBe(true);
		expect(
			redirectUriMatches(
				'https://claude.ai/api/mcp/auth_callback',
				'https://claude.ai/api/mcp/auth_callback/'
			)
		).toBe(false);
		expect(redirectUriMatches('https://claude.ai/cb', 'https://claude.ai:8443/cb')).toBe(false);
		expect(redirectUriMatches('http://localhost/callback', 'http://localhost:51234/callback')).toBe(
			true
		);
		expect(redirectUriMatches('http://127.0.0.1/callback', 'http://127.0.0.1:8080/callback')).toBe(
			true
		);
		expect(redirectUriMatches('http://localhost/callback', 'http://127.0.0.1:8080/callback')).toBe(
			false
		);
		expect(redirectUriMatches('http://localhost/callback', 'http://localhost:8080/other')).toBe(
			false
		);
		expect(
			redirectUriMatches('http://localhost/callback', 'http://localhost.evil.example/callback')
		).toBe(false);
		expect(
			allowsRedirect(
				{
					id: 'x',
					clientId: CLAUDE_CODE_ID,
					assistant: { name: 'Claude Code', identity: { kind: 'verified', host: 'claude.ai' } },
					redirectUris: CLAUDE_CODE_DOCUMENT.redirect_uris
				},
				'http://127.0.0.1:41000/callback'
			)
		).toBe(true);
	});
});
