import type { Handle } from '@sveltejs/kit/hooks';
import { isAgentPath } from '../guards/agent-paths.ts';

/**
 * Cross-site request protection (SPEC-SIGN-IN S8). SvelteKit checks only
 * form submissions; this refuses every state-changing request, JSON included,
 * whose `Origin` is not this server, and one with no `Origin` at all
 * (browsers always send it on these methods). Agents sign their requests and
 * carry no cookie, so their paths are exempt.
 */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isCrossOriginWrite(request: Request, url: URL): boolean {
	if (SAFE_METHODS.has(request.method) || isAgentPath(url.pathname)) {
		return false;
	}
	return request.headers.get('origin') !== url.origin;
}

export const originCheck: Handle = ({ event, resolve }) => {
	if (isCrossOriginWrite(event.request, event.url)) {
		return Response.json(
			{ message: 'This request came from another site, so it was refused.' },
			{ status: 403 }
		);
	}
	return resolve(event);
};
