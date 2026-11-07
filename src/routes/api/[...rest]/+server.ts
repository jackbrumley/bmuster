import { route } from '#lib/server/guards/route.ts';
import type { RequestHandler } from './$types';

/**
 * Any /api/ path no endpoint answers (SPEC-ERROR-PAGES E4): JSON in the same
 * `{ message }` shape as every other API refusal, for every method. Without it
 * SvelteKit answers with the HTML error page (or plain text to a `fetch`),
 * which the API client cannot read. Behind a session like the rest of /api
 * (401 first), so it says nothing to someone signed out. Every real endpoint
 * outranks a rest parameter, so this only catches what nothing else does.
 */
export const fallback: RequestHandler = route.user(() =>
	Response.json({ message: 'No such API endpoint.' }, { status: 404 })
);
