/**
 * Paths agents use (SPEC-SIGN-IN S7). They never carry a console session:
 * each checks its own credential (a join code, a signed request) or is a
 * public download, so the session and origin hooks leave them alone.
 */
export function isAgentPath(pathname: string): boolean {
	return (
		pathname.startsWith('/agent/') || pathname === '/install.sh' || pathname === '/install.ps1'
	);
}
