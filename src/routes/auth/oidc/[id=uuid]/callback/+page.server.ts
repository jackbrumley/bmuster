import { redirect } from '@sveltejs/kit';
import { safeReturnPath } from '#lib/domain/auth/return-path.ts';
import { database } from '#lib/server/database/app-database.ts';
import { env } from '#lib/server/env.ts';
import { page } from '#lib/server/guards/page.ts';
import { signInClient } from '#lib/server/services/auth/client.ts';
import {
	completeOidcSignIn,
	discoverProvider,
	FLOW_COOKIE,
	FLOW_COOKIE_PATH
} from '#lib/server/services/auth/oidc-sign-in.ts';
import { SESSION_COOKIE, sessionCookieOptions } from '#lib/server/services/auth/sessions.ts';
import type { PageServerLoad } from './$types';

/**
 * GET /auth/oidc/<id>/callback: the provider sends the browser back here.
 * Success signs in and moves on; a refusal shows its plain message (the
 * reason is in the audit log).
 */
export const load: PageServerLoad = page.public(async (event) => {
	const flowCookie = event.cookies.get(FLOW_COOKIE);
	event.cookies.delete(FLOW_COOKIE, { path: FLOW_COOKIE_PATH });
	const result = await completeOidcSignIn(
		database,
		event.params.id,
		{
			secretsKey: env.secretsKey,
			currentUrl: event.url,
			flowCookie,
			discover: discoverProvider,
			client: signInClient(event)
		},
		Date.now()
	);
	if (result.kind === 'refused') {
		return { message: result.message };
	}
	event.cookies.set(
		SESSION_COOKIE,
		result.session.token,
		sessionCookieOptions(result.session.expiresAt)
	);
	redirect(303, safeReturnPath(result.returnTo));
});
