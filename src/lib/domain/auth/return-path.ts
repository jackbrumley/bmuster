/**
 * Where to go after signing in: only a path on this server, so a crafted
 * link cannot send someone to another site (SPEC-SIGN-IN 7).
 */
export function safeReturnPath(candidate: string | null): string {
	if (candidate?.startsWith('/') !== true) {
		return '/';
	}
	// `//host` and `/\host` are other origins to a browser.
	if (candidate.startsWith('//') || candidate.startsWith('/\\')) {
		return '/';
	}
	// Control characters (a tab or newline) are dropped by browsers, which can turn `/\t/host` into `//host`.
	if (/\p{Cc}/u.test(candidate)) {
		return '/';
	}
	return candidate;
}
