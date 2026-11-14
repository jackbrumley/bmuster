import { fail, redirect } from '@sveltejs/kit';
import { safeReturnPath } from '#lib/domain/auth/return-path.ts';
import { setUpStepRequestSchema } from '#lib/schemas/auth/two-factor.ts';
import { database } from '#lib/server/database/app-database.ts';
import { env } from '#lib/server/env.ts';
import { page } from '#lib/server/guards/page.ts';
import { signInClient } from '#lib/server/services/auth/client.ts';
import { SESSION_COOKIE, sessionCookieOptions } from '#lib/server/services/auth/sessions.ts';
import { CHALLENGE_COOKIE } from '#lib/server/services/auth/sign-in-challenges.ts';
import { answerSetUpStep, setUpStepKey } from '#lib/server/services/auth/two-factor-sign-in.ts';
import { formText } from '#lib/utils/form-data.ts';
import { timedOut } from '../../sign-in-next.server.ts';
import type { Actions, PageServerLoad } from './$types';

/**
 * The set-up step (SPEC-TWO-FACTOR 2.5): someone the server requires to use two-factor, who has
 * not set it up, does it here before anything else. The session starts with the first right
 * code; the page then shows the recovery codes once, so the action replies instead of
 * redirecting, and `load` stays quiet once the challenge is used.
 */
export const load: PageServerLoad = page.public(({ cookies, locals, url }) => {
	const returnTo = safeReturnPath(url.searchParams.get('returnTo'));
	const token = cookies.get(CHALLENGE_COOKIE);
	const shown =
		token === undefined
			? ({ kind: 'timed-out' } as const)
			: setUpStepKey(database, env.secretsKey, token, Date.now());
	if (shown.kind === 'timed-out' && locals.session.kind === 'signed-in') {
		redirect(303, returnTo);
	}
	return {
		returnTo,
		origin: url.origin,
		step:
			shown.kind === 'key'
				? { kind: 'key' as const, twoFactorKey: shown.key, email: shown.email }
				: { kind: 'timed-out' as const }
	};
});

export const actions = {
	default: page.public(async (event) => {
		const data = await event.request.formData();
		const token = event.cookies.get(CHALLENGE_COOKIE);
		if (token === undefined) {
			timedOut(event.cookies);
		}
		const parsed = setUpStepRequestSchema.safeParse({ code: formText(data, 'code') });
		if (!parsed.success) {
			return fail(400, {
				message: parsed.error.issues[0]?.message ?? 'Type the code from your app.'
			});
		}
		const result = await answerSetUpStep(
			database,
			env.secretsKey,
			token,
			parsed.data.code,
			signInClient(event),
			Date.now()
		);
		if (result.kind === 'timed-out') {
			timedOut(event.cookies);
		}
		if (result.kind === 'refused') {
			return fail(400, { message: result.message });
		}
		event.cookies.delete(CHALLENGE_COOKIE, { path: '/login' });
		event.cookies.set(
			SESSION_COOKIE,
			result.session.token,
			sessionCookieOptions(result.session.expiresAt)
		);
		return { recoveryCodes: result.recoveryCodes, email: result.email };
	})
} satisfies Actions;
