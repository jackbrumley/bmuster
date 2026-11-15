import type { HandleClientError } from '@sveltejs/kit/hooks';
import { z } from 'zod';
import { navigating } from '$app/state';
import { mayReload, staleCode } from '#lib/utils/app-version.ts';

/**
 * The console runs under a strict Content-Security-Policy with no `unsafe-eval`
 * (SPEC-SIGN-IN S20). zod would otherwise probe `new Function` once to speed up
 * object parsing; the probe is caught, but Firefox reports it as a policy
 * violation on every page. Parsing without that speed-up is fast enough.
 */
z.config({ jitless: true });

/**
 * A navigation that trips over code an older build had and the server no
 * longer serves (a server update while this tab was open) loads its target
 * as a whole page instead of showing "Error 500" (SPEC-SERVER-UPDATES SU19).
 * Only navigations reload: an error while no navigation runs (a desktop
 * session, say) keeps the page.
 */
export const handleError: HandleClientError = ({ error }) => {
	const target = navigating.to?.url;
	if (target !== undefined && staleCode(error) && mayReload(target, Date.now(), tabStorage)) {
		window.location.href = target.href;
	}
};

/** This tab's sessionStorage, read inside the reload guard's try (reading it can throw). */
const tabStorage: Pick<Storage, 'getItem' | 'setItem'> = {
	getItem: (key) => sessionStorage.getItem(key),
	setItem: (key, value) => {
		sessionStorage.setItem(key, value);
	}
};
