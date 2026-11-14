import { MCP_SCOPES, mcpServerUrl } from '#lib/domain/mcp/mcp.ts';

/**
 * Discovery (SPEC-MCP M5, 4.2): RFC 9728 protected resource metadata for `/mcp`, whose `resource`
 * must equal exactly the URL people paste into their assistant, and RFC 8414 authorisation server
 * metadata. BMuster is the only authorisation server. Advertising both `"none"` and metadata
 * documents makes Claude's clients use CIMD; DCR stays for others.
 */

export const PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource/mcp';

export function protectedResourceMetadataUrl(origin: string): string {
	return `${origin}${PROTECTED_RESOURCE_PATH}`;
}

export function protectedResourceMetadata(origin: string) {
	return {
		resource: mcpServerUrl(origin),
		authorization_servers: [origin],
		scopes_supported: [...MCP_SCOPES],
		bearer_methods_supported: ['header'],
		resource_name: 'BMuster'
	};
}

export function authorizationServerMetadata(origin: string) {
	return {
		issuer: origin,
		authorization_endpoint: `${origin}/oauth/authorize`,
		token_endpoint: `${origin}/oauth/token`,
		registration_endpoint: `${origin}/oauth/register`,
		revocation_endpoint: `${origin}/oauth/revoke`,
		response_types_supported: ['code'],
		response_modes_supported: ['query'],
		grant_types_supported: ['authorization_code', 'refresh_token'],
		code_challenge_methods_supported: ['S256'],
		token_endpoint_auth_methods_supported: ['none'],
		revocation_endpoint_auth_methods_supported: ['none'],
		scopes_supported: [...MCP_SCOPES],
		client_id_metadata_document_supported: true,
		authorization_response_iss_parameter_supported: true
	};
}

/** The 401's challenge (M4): where the metadata is and which scope to ask for. */
export function bearerChallenge(origin: string, error: 'none' | 'invalid_token'): string {
	const parts = [
		`resource_metadata="${protectedResourceMetadataUrl(origin)}"`,
		`scope="${MCP_SCOPES.join(' ')}"`
	];
	if (error === 'invalid_token') {
		parts.push('error="invalid_token"');
	}
	return `Bearer ${parts.join(', ')}`;
}
