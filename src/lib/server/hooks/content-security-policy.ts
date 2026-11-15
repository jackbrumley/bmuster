/**
 * The Content-Security-Policy, declared once (SPEC-SIGN-IN S20). vite.config.ts hands these
 * directives to SvelteKit (`csp`), which sends them on every page it renders with a fresh nonce
 * for its own inline scripts; the security headers hook sends the same policy, without a
 * nonce, on every other response (API replies, redirects, the last-resort error page).
 *
 * No imports beyond types: vite.config.ts loads this file before the app exists.
 */
import type { Config } from '@sveltejs/kit/vite';

type CspDirectives = NonNullable<NonNullable<Config['csp']>['directives']>;

/**
 * The two inline scripts SvelteKit does not write: the theme script in src/app.html and its copy
 * in src/error.html (which is served without a nonce). Allowed by hash, so editing either script
 * means updating its hash; security-headers.test.ts says when.
 */
export const INLINE_SCRIPT_HASHES = {
	app: 'sha256-0GWvkCYqE/Nzlju9N9G1VLJJ/ES9iRz7Hs5Zz1Mhu3A=',
	error: 'sha256-ato/Yvelzf7bIszLgYUk2Lzekpkjg1rpfvSYQb/29vU='
} as const;

export const CSP_DIRECTIVES = {
	'default-src': ['self'],
	// SvelteKit adds the page's nonce for its start-up script.
	'script-src': ['self', INLINE_SCRIPT_HASHES.app, INLINE_SCRIPT_HASHES.error],
	// 'unsafe-inline' cannot be avoided for styles: Svelte renders `style=` attributes and
	// `style:` directives into the HTML (nonces and hashes never cover attributes), app.html
	// wraps the body in one, and xterm.js adds <style> elements while it runs. SvelteKit adds no
	// nonce here, which matters: a nonce in the list would make browsers ignore 'unsafe-inline'.
	'style-src': ['self', 'unsafe-inline'],
	// data: for the inline logo of the last-resort error page; blob: for images made in the page.
	'img-src': ['self', 'data:', 'blob:'],
	// 'self' covers ws: and wss: to this server (CSP Level 3), which the session sockets use; the
	// live updates (EventSource) and the API are same-origin too.
	'connect-src': ['self'],
	'object-src': ['none'],
	'base-uri': ['self'],
	// Pages whose forms lead to another site (the AI assistant consent page) add that one origin
	// for their own response; see FORM_ACTION_HEADER.
	'form-action': ['self'],
	'frame-ancestors': ['none']
} satisfies CspDirectives;

/** Keywords and hashes are quoted in a policy; schemes and hosts are not (as SvelteKit does). */
function source(value: string): string {
	return /^(self|none|unsafe-inline|unsafe-eval|strict-dynamic)$|^(nonce|sha\d{3})-/.test(value)
		? `'${value}'`
		: value;
}

/** The policy as a header value, with `formTargets` added to `form-action`. */
export function policyText(formTargets: readonly string[]): string {
	return Object.entries(CSP_DIRECTIVES)
		.map(([name, values]) => {
			const sources = name === 'form-action' ? [...values, ...formTargets] : [...values];
			return `${name} ${sources.map(source).join(' ')}`;
		})
		.join('; ');
}
