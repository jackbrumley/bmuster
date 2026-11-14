import { MCP_SCOPES, mcpServerUrl } from '#lib/domain/mcp/mcp.ts';
import { CLIENT_AUTH_METHODS } from './client-auth.ts';

/**
 * Discovery (SPEC-MCP M5, M32, 4.2): RFC 9728 protected resource metadata for `/mcp`, whose
 * `resource` must equal exactly the URL people paste into their assistant, and RFC 8414
 * authorisation server metadata. BMuster is the only authorisation server. Advertising both
 * `"none"` and metadata documents makes Claude's and ChatGPT's clients use CIMD; DCR stays for
 * others, public or with a client secret (M33).
 *
 * The same resource document is served at the root path too (`/.well-known/oauth-protected-
 * resource`), which some clients probe; and the same authorisation server document at
 * `/.well-known/openid-configuration`, which some clients try before RFC 8414. That document
 * claims no OpenID features (no `id_token`, no `userinfo`, no `jwks_uri`, no `openid` scope), so
 * a client after OpenID sign-in sees there is none, and an OAuth client reads what it needs.
 */

const PROTECTED_RESOURCE_PATH = '/.well-known/oauth-protected-resource/mcp';

function protectedResourceMetadataUrl(origin: string): string {
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
		token_endpoint_auth_methods_supported: [...CLIENT_AUTH_METHODS],
		revocation_endpoint_auth_methods_supported: [...CLIENT_AUTH_METHODS],
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
