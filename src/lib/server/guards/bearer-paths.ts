/**
 * Paths an AI assistant calls with no console session (SPEC-MCP M4): the MCP endpoint, the
 * OAuth token, registration and revocation endpoints, and the discovery documents. They never
 * read the console cookie (an MCP request must not ride on a browser's session), and they are
 * not browser form posts, so the origin hook leaves them to their own guards. The consent screen
 * (`/oauth/authorize`) is a console page and is not listed.
 */
const BEARER_PATHS: ReadonlySet<string> = new Set([
	'/mcp',
	'/oauth/token',
	'/oauth/register',
	'/oauth/revoke'
]);

export function isBearerPath(pathname: string): boolean {
	return BEARER_PATHS.has(pathname) || pathname.startsWith('/.well-known/');
}
