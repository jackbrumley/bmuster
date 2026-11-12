import { randomBytes } from 'node:crypto';
import type { HandleServerError } from '@sveltejs/kit/hooks';
import { UNEXPECTED_ERROR_MESSAGE } from '#lib/domain/errors/error-copy.ts';

/**
 * Server errors (SPEC-ERROR-PAGES E5). An error nobody threw on purpose, or a
 * 5xx from SvelteKit itself, is written to the server log under a short
 * reference, with its stack. The browser gets only a plain message and that
 * reference, so the person can quote it and Jack can find the log line;
 * nothing of the error itself leaves the server (AGENTS.md §9).
 *
 * Errors a route threw with `error(…)` and SvelteKit's 4xx (a page that does
 * not exist, a method an endpoint does not have) are expected: they keep
 * their own status and message, and are not logged.
 */
export function serverErrorHandler(
	write: (line: string) => void,
	newReference: () => string
): HandleServerError {
	return (caught) => {
		const where = `${caught.event.request.method} ${loggedPath(caught.event.url.pathname)}`;
		switch (caught.kind) {
			case 'app':
			case 'validation':
				return {};
			case 'framework': {
				if (caught.error.status < 500) {
					return {};
				}
				const reference = newReference();
				write(`Error ${reference}: ${where}: ${caught.error.message}`);
				return { reference };
			}
			case 'unknown': {
				const reference = newReference();
				write(`Error ${reference}: ${where}: ${describe(caught.error)}`);
				return { status: 500, message: UNEXPECTED_ERROR_MESSAGE, reference };
			}
		}
	};
}

/**
 * The path as the log may keep it: a share link's token is a key to a machine, so
 * `/s/<token>/…` is written `/s/…/…` (SPEC-SHARE-LINKS D11).
 */
function loggedPath(pathname: string): string {
	return pathname.replace(/^(.*?\/s\/)[^/]+/, '$1…');
}

function describe(error: unknown): string {
	return error instanceof Error
		? (error.stack ?? `${error.name}: ${error.message}`)
		: String(error);
}

/** Eight hex characters: short enough to read out, unique enough to find one log line. */
export function errorReference(): string {
	return randomBytes(4).toString('hex');
}
