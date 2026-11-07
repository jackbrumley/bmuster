import { page } from '#lib/server/guards/page.ts';
import type { LayoutServerLoad } from './$types';

/**
 * Whether someone is signed in, for pages outside the console: the error page
 * offers "Go to Machines" or "Sign in" by it (SPEC-ERROR-PAGES E1). It reads
 * only the session the hook already checked.
 */
export const load: LayoutServerLoad = page.public(({ locals }) => ({
	signedIn: locals.session.kind === 'signed-in'
}));
