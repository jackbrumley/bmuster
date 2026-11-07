import { fail, redirect } from '@sveltejs/kit';
import { setupRequestSchema } from '#lib/schemas/auth/sign-in.ts';
import { database } from '#lib/server/database/app-database.ts';
import { page } from '#lib/server/guards/page.ts';
import { signInClient } from '#lib/server/services/auth/client.ts';
import { SESSION_COOKIE, sessionCookieOptions } from '#lib/server/services/auth/sessions.ts';
import { setupFirstAdmin } from '#lib/server/services/auth/setup.ts';
import { hasUsers } from '#lib/server/services/users/users.ts';
import { formText } from '#lib/utils/form-data.ts';
import type { Actions, PageServerLoad } from './$types';

/** /setup exists only while the server has no users (SPEC-SIGN-IN S1); afterwards it sends people to sign in. */
export const load: PageServerLoad = page.public(() => {
	if (hasUsers(database)) {
		redirect(303, '/login');
	}
	return {};
});

export const actions = {
	default: page.public(async (event) => {
		const data = await event.request.formData();
		const values = {
			name: formText(data, 'name'),
			email: formText(data, 'email'),
			password: formText(data, 'password')
		};
		const parsed = setupRequestSchema.safeParse(values);
		if (!parsed.success) {
			const issue = parsed.error.issues[0];
			return fail(400, {
				name: values.name,
				email: values.email,
				field: String(issue?.path[0] ?? ''),
				message: issue?.message ?? 'Check the details.'
			});
		}
		const result = await setupFirstAdmin(database, parsed.data, signInClient(event), Date.now());
		if (result.kind === 'closed') {
			redirect(303, '/login');
		}
		event.cookies.set(
			SESSION_COOKIE,
			result.session.token,
			sessionCookieOptions(result.session.expiresAt)
		);
		redirect(303, '/');
	})
} satisfies Actions;
