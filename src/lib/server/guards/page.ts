import { error, type RequestEvent } from '@sveltejs/kit';
import { database } from '../database/app-database.ts';
import { mcpEnabled } from '../services/oauth/mcp-settings.ts';
import { requirePageAccess, type SessionContext } from './checks.ts';

/**
 * Guards for `load` functions and form actions in `+page.server.ts` and
 * `+layout.server.ts` (SPEC-SIGN-IN S7). Every `load` and action is built by
 * one (hygiene: route-guard-required):
 *
 * ```ts
 * export const load: PageServerLoad = page.admin((event, { user }) => ({ … }));
 * ```
 *
 * Signed out → /login (and back afterwards); a member on an admin page → 403.
 */
type Guarded<E extends RequestEvent, C, R> = (event: E, context: C) => R;

export const page = {
	public<E extends RequestEvent, R>(fn: Guarded<E, null, R>) {
		return (event: E): R => fn(event, null);
	},

	user<E extends RequestEvent, R>(fn: Guarded<E, SessionContext, R>) {
		return (event: E): R => fn(event, requirePageAccess(event, 'user'));
	},

	admin<E extends RequestEvent, R>(fn: Guarded<E, SessionContext, R>) {
		return (event: E): R => fn(event, requirePageAccess(event, 'admin'));
	},

	/**
	 * The consent screen (SPEC-MCP M1, M7): pages under /oauth/ only. 404 while MCP is off, before
	 * anything else; then a console session like `user` (sign-in first, and back afterwards).
	 */
	oauth<E extends RequestEvent, R>(fn: Guarded<E, SessionContext, R>) {
		return (event: E): R => {
			if (!mcpEnabled(database)) {
				error(404, 'Not found');
			}
			return fn(event, requirePageAccess(event, 'user'));
		};
	}
};
