/**
 * Open tabs after a server update (SPEC-SERVER-UPDATES SU17–SU19). A tab
 * opened before the update still runs the old build's code; its next
 * client-side navigation would ask for code chunks the new build no longer
 * has, and SvelteKit would show "Error 500". So the client asks every minute
 * whether a new version is out, the next navigation after one is a full page
 * load, and a navigation that still trips over missing code reloads its
 * target once. Nothing here reloads a page by itself: a desktop session
 * keeps running until the person navigates.
 */

/** How often the client asks the server for its version (`kit.version.pollInterval`). */
export const VERSION_POLL_MS = 60_000;

/** A reload of the same address this soon after the last one is a loop, not an update. */
const RELOAD_AGAIN_AFTER_MS = 30_000;

const RELOAD_KEY = 'bmuster.app.reloadedFor';

/**
 * Where to load the whole page instead of navigating inside it: the
 * navigation's target, once a new version is known. Undefined when the
 * browser is leaving the page anyway, or the navigation goes nowhere.
 */
export function fullLoadTarget(
	navigation: { willUnload: boolean; to: { url: URL } | null },
	updated: boolean
): URL | undefined {
	if (!updated || navigation.willUnload || navigation.to === null) {
		return undefined;
	}
	return navigation.to.url;
}

/** What browsers say when a code chunk or its stylesheet is gone from the server. */
const STALE_CODE = [
	// Chrome, Edge
	'Failed to fetch dynamically imported module',
	// Safari
	'Importing a module script failed',
	// Firefox
	'error loading dynamically imported module',
	// Vite's stylesheet preload
	'Unable to preload CSS'
];

/** The error is a code chunk the server no longer has (an older build's). */
export function staleCode(error: unknown): boolean {
	return error instanceof Error && STALE_CODE.some((text) => error.message.includes(text));
}

/**
 * Whether to reload `url` now: not if this tab reloaded it in the last 30
 * seconds, so code that never loads (a network fault, not an update) shows
 * the error page instead of reloading for ever. Blocked storage allows it.
 */
export function mayReload(
	url: URL,
	nowMs: number,
	storage: Pick<Storage, 'getItem' | 'setItem'>
): boolean {
	try {
		const last = storage.getItem(RELOAD_KEY);
		if (last !== null) {
			const [href, at] = [last.slice(last.indexOf(' ') + 1), Number(last.split(' ', 1)[0])];
			if (href === url.href && nowMs - at < RELOAD_AGAIN_AFTER_MS) {
				return false;
			}
		}
		storage.setItem(RELOAD_KEY, `${String(nowMs)} ${url.href}`);
	} catch {
		// Storage is blocked: reload; the loop guard is a convenience.
	}
	return true;
}
