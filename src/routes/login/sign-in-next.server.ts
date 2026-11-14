import { redirect, type Cookies } from '@sveltejs/kit';
import { resolve } from '$app/paths';
import { SESSION_COOKIE, sessionCookieOptions } from '#lib/server/services/auth/sessions.ts';
import {
	CHALLENGE_COOKIE,
	challengeCookieOptions
} from '#lib/server/services/auth/sign-in-challenges.ts';
import type { SignInNext } from '#lib/server/services/auth/sign-in-steps.ts';

/**
 * After a right password (sign-in, first-run setup, an invitation): the session cookie and the
 * page they asked for, or the challenge cookie and the two-factor step (SPEC-TWO-FACTOR 2.3).
 * `returnTo` must already be a safe same-origin path.
 */
export function continueSignIn(cookies: Cookies, next: SignInNext, returnTo: string): never {
	if (next.kind === 'session') {
		cookies.set(SESSION_COOKIE, next.session.token, sessionCookieOptions(next.session.expiresAt));
		redirect(303, returnTo);
	}
	cookies.set(
		CHALLENGE_COOKIE,
		next.challenge.token,
		challengeCookieOptions(next.challenge.expiresAt)
	);
	const step =
		next.challenge.step === 'code'
			? resolve('/login/two-factor')
			: resolve('/login/two-factor/set-up');
	redirect(303, `${step}?${new URLSearchParams({ returnTo }).toString()}`);
}

/** Where a step page sends someone whose challenge has run out. */
export function timedOut(cookies: Cookies): never {
	cookies.delete(CHALLENGE_COOKIE, { path: '/login' });
	redirect(303, `${resolve('/login')}?${new URLSearchParams({ timedOut: '1' }).toString()}`);
}
