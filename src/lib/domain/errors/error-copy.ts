/**
 * What the error pages say (SPEC-ERROR-PAGES E1–E3). Browser-safe: the root
 * error page, the console's and the machine tabs' all read from here, so a
 * status reads the same wherever it shows.
 */
export type ErrorCopy = { title: string; explanation: string };

/** Where the error happened: anywhere, or on a machine's own pages. */
export type ErrorPlace = 'page' | 'machine';

/**
 * The message an unexpected server error carries to the browser (the error
 * page and JSON replies alike). The real reason goes to the server log with
 * the error's reference, never to the browser (AGENTS.md §9).
 */
export const UNEXPECTED_ERROR_MESSAGE = 'Something went wrong on the server.';

const SERVER_ERROR: ErrorCopy = {
	title: 'Something went wrong',
	explanation: 'The server ran into a problem. Try again in a moment.'
};

const BY_STATUS: Readonly<Record<number, ErrorCopy>> = {
	401: { title: 'Please sign in', explanation: 'You need to sign in to see this page.' },
	403: {
		title: 'Not allowed',
		explanation: "Your account can't open this page. An admin can change that."
	},
	404: {
		title: 'Page not found',
		explanation: "There's nothing at this address. The link may be old or mistyped."
	},
	429: { title: 'Too many tries', explanation: 'Wait a minute, then try again.' },
	500: SERVER_ERROR,
	503: {
		title: 'Not available right now',
		explanation: 'BMuster is busy or starting up. Try again in a moment.'
	}
};

const OTHER_REQUEST_ERROR: ErrorCopy = {
	title: "That didn't work",
	explanation: "The server couldn't handle this request."
};

const MACHINE_NOT_FOUND: ErrorCopy = {
	title: 'Machine not found',
	explanation: 'It may have been removed, or you may not have access.'
};

/** 5xx: the server's fault, so trying again can help. */
export function isServerError(status: number): boolean {
	return status >= 500;
}

export function errorCopy(status: number, place: ErrorPlace): ErrorCopy {
	// A member gets 404 for a machine they may not see (SPEC-ACCESS A6), so the
	// words cover both.
	if (status === 404 && place === 'machine') {
		return MACHINE_NOT_FOUND;
	}
	const known = BY_STATUS[status];
	if (known !== undefined) {
		return known;
	}
	return isServerError(status) ? SERVER_ERROR : OTHER_REQUEST_ERROR;
}

/**
 * The words SvelteKit and the error hook put on errors nobody wrote a message
 * for. Showing them under the title would only repeat it.
 */
const GENERIC_MESSAGES: ReadonlySet<string> = new Set([
	'Bad Request',
	'Unauthorized',
	'Forbidden',
	'Not Found',
	'Method Not Allowed',
	'Too Many Requests',
	'Internal Error',
	'Service Unavailable',
	UNEXPECTED_ERROR_MESSAGE
]);

/**
 * The error's own message, when it adds something to the title: one a route
 * wrote on purpose (`error(403, 'Only admins can open this page.')`). Never a
 * generic one, and never on a machine 404, whose words already say it all.
 */
export function errorDetail(
	status: number,
	place: ErrorPlace,
	message: string
): { kind: 'none' } | { kind: 'message'; text: string } {
	const text = message.trim();
	if (
		text === '' ||
		GENERIC_MESSAGES.has(text) ||
		text.startsWith('Not found: ') ||
		text === `Error: ${status}` ||
		(status === 404 && place === 'machine')
	) {
		return { kind: 'none' };
	}
	return { kind: 'message', text };
}

/** Machine pages: the route ids under /machines/[id]. */
export function errorPlace(routeId: string | null): ErrorPlace {
	return routeId?.startsWith('/(console)/machines/[id]') === true ? 'machine' : 'page';
}
