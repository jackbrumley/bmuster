import { fail, redirect } from '@sveltejs/kit';
import { safeReturnPath } from '#lib/domain/auth/return-path.ts';
import { codeStepRequestSchema } from '#lib/schemas/auth/two-factor.ts';
import { database } from '#lib/server/database/app-database.ts';
import { env } from '#lib/server/env.ts';
import { page } from '#lib/server/guards/page.ts';
import { signInClient } from '#lib/server/services/auth/client.ts';
import { CHALLENGE_COOKIE, findChallenge } from '#lib/server/services/auth/sign-in-challenges.ts';
import { answerCodeStep } from '#lib/server/services/auth/two-factor-sign-in.ts';
import { formText } from '#lib/utils/form-data.ts';
import { continueSignIn, timedOut } from '../sign-in-next.server.ts';
import type { Actions, PageServerLoad } from './$types';

/**
 * The code step (SPEC-TWO-FACTOR 2.4): after a right password, a code from the authenticator
 * app or a recovery code. Only the challenge cookie gets here; it grants nothing else.
 */
export const load: PageServerLoad = page.public(({ cookies, locals, url }) => {
	const returnTo = safeReturnPath(url.searchParams.get('returnTo'));
	if (locals.session.kind === 'signed-in') {
		redirect(303, returnTo);
	}
	const token = cookies.get(CHALLENGE_COOKIE);
	if (token === undefined || findChallenge(database, token, 'code', Date.now()).kind === 'none') {
		timedOut(cookies);
	}
	return { returnTo };
});

export const actions = {
	default: page.public(async (event) => {
		const data = await event.request.formData();
		const token = event.cookies.get(CHALLENGE_COOKIE);
		if (token === undefined) {
			timedOut(event.cookies);
		}
		const parsed = codeStepRequestSchema.safeParse({ code: formText(data, 'code') });
		if (!parsed.success) {
			return fail(400, { message: parsed.error.issues[0]?.message ?? 'Type the code.' });
		}
		const result = answerCodeStep(
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
		continueSignIn(
			event.cookies,
			{ kind: 'session', session: result.session },
			safeReturnPath(event.url.searchParams.get('returnTo'))
		);
	})
} satisfies Actions;
