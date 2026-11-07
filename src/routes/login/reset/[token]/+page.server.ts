import { fail } from '@sveltejs/kit';
import { passwordSchema } from '#lib/schemas/auth/sign-in.ts';
import { database } from '#lib/server/database/app-database.ts';
import { page } from '#lib/server/guards/page.ts';
import { findUsableLink } from '#lib/server/services/auth/password-links.ts';
import { resetPassword } from '#lib/server/services/auth/password-reset.ts';
import { formText } from '#lib/utils/form-data.ts';
import type { Actions, PageServerLoad } from './$types';

/**
 * A password reset link (SPEC-EMAIL E4): choose a new password, once, within
 * 30 minutes. Afterwards every session of the account ends, and the person
 * signs in again with the new password.
 */
export const load: PageServerLoad = page.public(({ params }) => ({
	usable: findUsableLink(database, params.token, 'reset', Date.now()).kind === 'usable'
}));

export const actions = {
	default: page.public(async ({ params, request }) => {
		const data = await request.formData();
		const parsed = passwordSchema.safeParse(formText(data, 'password'));
		if (!parsed.success) {
			return fail(400, { message: parsed.error.issues[0]?.message ?? 'Choose a longer password.' });
		}
		const result = await resetPassword(database, params.token, parsed.data, Date.now());
		switch (result.kind) {
			case 'link-unusable':
				return fail(410, {
					message: 'This link has expired or was already used. Ask for a new one.'
				});
			case 'done':
				return { done: true as const };
		}
	})
} satisfies Actions;
