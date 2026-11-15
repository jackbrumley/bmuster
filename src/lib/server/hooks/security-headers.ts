import type { Handle } from '@sveltejs/kit/hooks';
import { env } from '../env.ts';
import { servedCertificate } from '../tls/served-certificate.ts';
import { policyText } from './content-security-policy.ts';

/**
 * Browser security headers on every response the app gives (SPEC-SIGN-IN S20): pages, API
 * replies, redirects and error pages. Each is a default: a route that sets its own (the share
 * link pages' Referrer-Policy) keeps it. Pages carry SvelteKit's Content-Security-Policy, made
 * from content-security-policy.ts with a nonce; every other response gets the same policy here.
 */

/**
 * A page whose forms lead to another site sets this on its response with that one origin (the
 * AI assistant consent page, whose Allow and Cancel redirect to the assistant: browsers apply
 * `form-action` to a form's redirects too). The hook adds the origin to `form-action` and drops
 * the header, so it never reaches the browser.
 */
export const FORM_ACTION_HEADER = 'x-bmuster-form-action';

const HSTS = 'max-age=31536000';

const DEFAULTS: readonly (readonly [string, string])[] = [
	['x-frame-options', 'DENY'],
	['x-content-type-options', 'nosniff'],
	['referrer-policy', 'same-origin'],
	// The desktop's clipboard needs clipboard-read and -write; nothing uses a camera,
	// microphone or location.
	[
		'permissions-policy',
		'camera=(), microphone=(), geolocation=(), clipboard-read=(self), clipboard-write=(self)'
	]
];

/**
 * Whether this request reached the server over HTTPS. With the server's own certificate (local
 * network mode, or the dev server's) every request does. Behind a proxy only the proxy knows:
 * the request's scheme is believed only when PROTOCOL_HEADER names the header the proxy sets
 * (as the container image does), because adapter-node assumes https when it has no header.
 */
function reachedOverHttps(request: Request, protocolHeader: string | undefined): boolean {
	const served = servedCertificate();
	switch (served.kind) {
		case 'own':
		case 'dev':
			return true;
		case 'plain': {
			if (protocolHeader === undefined) return false;
			const forwarded = request.headers.get(protocolHeader);
			return forwarded !== null && forwarded.split(',')[0]?.trim().toLowerCase() === 'https';
		}
	}
}

/** One origin and nothing else, so a value can never add a directive to the policy. */
function formTarget(value: string): string {
	let origin: string;
	try {
		origin = new URL(value).origin;
	} catch {
		throw new Error(`${FORM_ACTION_HEADER} must be an origin, not ${value}`);
	}
	if (origin !== value || origin === 'null') {
		throw new Error(`${FORM_ACTION_HEADER} must be an origin, not ${value}`);
	}
	return origin;
}

function withFormTarget(policy: string, target: string): string {
	return policy
		.split(';')
		.map((directive) => {
			const trimmed = directive.trim();
			return trimmed.startsWith('form-action ') ? `${trimmed} ${target}` : trimmed;
		})
		.join('; ');
}

/** The response with the headers set; a copy when its own headers cannot be changed. */
function secured(response: Response, https: boolean): Response {
	let target: Response = response;
	try {
		target.headers.set('x-content-type-options', 'nosniff');
	} catch {
		// Response.redirect and fetched responses have immutable headers.
		target = new Response(response.body, response);
	}
	const headers = target.headers;
	for (const [name, value] of DEFAULTS) {
		if (!headers.has(name)) headers.set(name, value);
	}
	const extra = headers.get(FORM_ACTION_HEADER);
	headers.delete(FORM_ACTION_HEADER);
	const targets = extra === null ? [] : [formTarget(extra)];
	const policy = headers.get('content-security-policy');
	if (policy === null) {
		headers.set('content-security-policy', policyText(targets));
	} else if (targets[0] !== undefined) {
		headers.set('content-security-policy', withFormTarget(policy, targets[0]));
	}
	if (https) {
		headers.set('strict-transport-security', HSTS);
	}
	return target;
}

/** The hook, for a given PROTOCOL_HEADER (tests pass their own). */
export function securityHeadersFor(protocolHeader: string | undefined): Handle {
	return async ({ event, resolve }) => {
		const response = await resolve(event);
		return secured(response, reachedOverHttps(event.request, protocolHeader));
	};
}

export const securityHeaders: Handle = securityHeadersFor(env.protocolHeader);
