import { error, redirect } from '@sveltejs/kit';
import { safeReturnPath } from '#lib/domain/auth/return-path.ts';
import { database } from '#lib/server/database/app-database.ts';
import { env } from '#lib/server/env.ts';
import { route } from '#lib/server/guards/route.ts';
import {
	discoverProvider,
	FLOW_COOKIE,
	FLOW_COOKIE_PATH,
	FLOW_MAX_AGE_SECONDS,
	startOidcSignIn
} from '#lib/server/services/auth/oidc-sign-in.ts';
import type { RequestHandler } from './$types';

/** GET /auth/oidc/<id>/start: off to the provider, with PKCE, state and nonce (SPEC-SIGN-IN S10). */
export const GET: RequestHandler = route.public(async ({ params, url, cookies }) => {
	const result = await startOidcSignIn(
		database,
		params.id,
		{
			secretsKey: env.secretsKey,
			redirectUri: `${url.origin}/auth/oidc/${params.id}/callback`,
			returnTo: safeReturnPath(url.searchParams.get('returnTo')),
			discover: discoverProvider
		},
		Date.now()
	);
	if (result.kind === 'refused') {
		error(404, result.message);
	}
	cookies.set(FLOW_COOKIE, result.flowCookie, {
		path: FLOW_COOKIE_PATH,
		httpOnly: true,
		secure: true,
		sameSite: 'lax',
		maxAge: FLOW_MAX_AGE_SECONDS
	});
	redirect(303, result.authorizationUrl);
});
