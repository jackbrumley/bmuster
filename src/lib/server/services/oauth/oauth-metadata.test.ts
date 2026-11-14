import { describe, expect, it } from 'vitest';
import {
	authorizationServerMetadata,
	bearerChallenge,
	protectedResourceMetadata
} from './metadata.ts';

const ORIGIN = 'https://bmuster.example.com';

describe('discovery (SPEC-MCP M5)', () => {
	it('M5: protected resource metadata names exactly <origin>/mcp and BMuster as the only server', () => {
		expect(protectedResourceMetadata(ORIGIN)).toMatchObject({
			resource: 'https://bmuster.example.com/mcp',
			authorization_servers: [ORIGIN]
		});
	});

	it('M5: authorisation server metadata advertises S256, CIMD, "none", iss and DCR', () => {
		const metadata = authorizationServerMetadata(ORIGIN);
		expect(metadata).toMatchObject({
			issuer: ORIGIN,
			code_challenge_methods_supported: ['S256'],
			client_id_metadata_document_supported: true,
			token_endpoint_auth_methods_supported: ['none'],
			authorization_response_iss_parameter_supported: true,
			registration_endpoint: `${ORIGIN}/oauth/register`,
			revocation_endpoint: `${ORIGIN}/oauth/revoke`
		});
		expect(metadata.scopes_supported).toContain('offline_access');
		expect(metadata.scopes_supported).toContain('machines:read');
	});

	it('M5: the 401 challenge points at the resource metadata and names the scope', () => {
		expect(bearerChallenge(ORIGIN, 'none')).toBe(
			`Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp", scope="machines:read commands:run offline_access"`
		);
		expect(bearerChallenge(ORIGIN, 'invalid_token')).toContain('error="invalid_token"');
	});
});
