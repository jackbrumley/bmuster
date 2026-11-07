import { fail, redirect } from '@sveltejs/kit';
import { safeReturnPath } from '#lib/domain/auth/return-path.ts';
import { signInRequestSchema } from '#lib/schemas/auth/sign-in.ts';
import { database } from '#lib/server/database/app-database.ts';
import { page } from '#lib/server/guards/page.ts';
import { signInClient } from '#lib/server/services/auth/client.ts';
import { signInProviders } from '#lib/server/services/auth/identity-providers.ts';
import { signInWithPassword, WRONG_DETAILS } from '#lib/server/services/auth/password-sign-in.ts';
import { SESSION_COOKIE, sessionCookieOptions } from '#lib/server/services/auth/sessions.ts';
import { formText } from '#lib/utils/form-data.ts';
import type { Actions, PageServerLoad } from './$types';

/** The sign-in page: a password, or "Continue with" each enabled provider (SPEC-SIGN-IN 3). */
export const load: PageServerLoad = page.public(({ locals, url }) => {
	const returnTo = safeReturnPath(url.searchParams.get('returnTo'));
	if (locals.session.kind === 'signed-in') {
		redirect(303, returnTo);
	}
	return { providers: signInProviders(database), returnTo };
});

export const actions = {
	default: page.public(async (event) => {
		const data = await event.request.formData();
		const email = formText(data, 'email');
		const parsed = signInRequestSchema.safeParse({ email, password: formText(data, 'password') });
		if (!parsed.success) {
			return fail(400, { email, message: WRONG_DETAILS });
		}
		const result = await signInWithPassword(database, parsed.data, signInClient(event), Date.now());
		if (result.kind === 'refused') {
			return fail(400, { email, message: result.message });
		}
		event.cookies.set(
			SESSION_COOKIE,
			result.session.token,
			sessionCookieOptions(result.session.expiresAt)
		);
		redirect(303, safeReturnPath(event.url.searchParams.get('returnTo')));
	})
} satisfies Actions;
