import { fail, redirect } from '@sveltejs/kit';
import { emailSchema } from '#lib/schemas/auth/sign-in.ts';
import { database } from '#lib/server/database/app-database.ts';
import { env } from '#lib/server/env.ts';
import { page } from '#lib/server/guards/page.ts';
import { requestPasswordReset } from '#lib/server/services/auth/password-reset.ts';
import { wakeEmailWorker } from '#lib/server/services/email/email-worker.ts';
import { emailReadiness } from '#lib/server/services/settings/email-settings.ts';
import { formText } from '#lib/utils/form-data.ts';
import type { Actions, PageServerLoad } from './$types';

/**
 * Forgot password (SPEC-EMAIL E4). The answer is the same whether or not the
 * address belongs to anyone, so the page cannot be used to find accounts.
 */
export const load: PageServerLoad = page.public(({ locals }) => {
	if (locals.session.kind === 'signed-in') {
		redirect(303, '/');
	}
	return { emailReady: emailReadiness(database).kind === 'ready' };
});

export const actions = {
	default: page.public(async ({ request }) => {
		const data = await request.formData();
		const email = formText(data, 'email');
		const parsed = emailSchema.safeParse(email);
		if (!parsed.success) {
			return fail(400, { email, message: 'Enter the email address you sign in with.' });
		}
		const result = requestPasswordReset(database, parsed.data, env.secretsKey, Date.now());
		switch (result.kind) {
			case 'email-off':
				return fail(409, {
					email,
					message: 'This server cannot send email yet. Ask an admin to reset your password.'
				});
			case 'accepted':
				wakeEmailWorker();
				return { sent: true as const, email: parsed.data };
		}
	})
} satisfies Actions;
