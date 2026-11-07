import { fail, redirect } from '@sveltejs/kit';
import { passwordSchema } from '#lib/schemas/auth/sign-in.ts';
import { database } from '#lib/server/database/app-database.ts';
import { page } from '#lib/server/guards/page.ts';
import { signInClient } from '#lib/server/services/auth/client.ts';
import { SESSION_COOKIE, sessionCookieOptions } from '#lib/server/services/auth/sessions.ts';
import { acceptInvitation, lookUpInvitation } from '#lib/server/services/users/invitations.ts';
import { formText } from '#lib/utils/form-data.ts';
import type { Actions, PageServerLoad } from './$types';

/**
 * An invitation link (SPEC-EMAIL E5): the invited person chooses their
 * password, once, within 7 days, and is signed in.
 */
export const load: PageServerLoad = page.public(({ params }) => ({
	invitation: lookUpInvitation(database, params.token, Date.now())
}));

export const actions = {
	default: page.public(async (event) => {
		const data = await event.request.formData();
		const parsed = passwordSchema.safeParse(formText(data, 'password'));
		if (!parsed.success) {
			return fail(400, { message: parsed.error.issues[0]?.message ?? 'Choose a longer password.' });
		}
		const result = await acceptInvitation(
			database,
			event.params.token,
			parsed.data,
			signInClient(event),
			Date.now()
		);
		if (result.kind === 'unusable') {
			return fail(410, {
				message: 'This invitation has expired or was already used. Ask an admin for a new one.'
			});
		}
		event.cookies.set(
			SESSION_COOKIE,
			result.session.token,
			sessionCookieOptions(result.session.expiresAt)
		);
		redirect(303, '/');
	})
} satisfies Actions;
