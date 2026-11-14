import { fail, redirect } from '@sveltejs/kit';
import { setupRequestSchema } from '#lib/schemas/auth/sign-in.ts';
import { database } from '#lib/server/database/app-database.ts';
import { page } from '#lib/server/guards/page.ts';
import { signInClient } from '#lib/server/services/auth/client.ts';
import { setupFirstAdmin } from '#lib/server/services/auth/setup.ts';
import { serverSetupCode } from '#lib/server/services/auth/setup-code.ts';
import { hasUsers } from '#lib/server/services/users/users.ts';
import { formText } from '#lib/utils/form-data.ts';
import { continueSignIn } from '../login/sign-in-next.server.ts';
import type { Actions, PageServerLoad } from './$types';

/**
 * /setup exists only while the server has no users (SPEC-SIGN-IN S1);
 * afterwards it sends people to sign in. It needs the setup code from the
 * server's log (S17); one is printed if none is waiting (after a dev reload).
 */
export const load: PageServerLoad = page.public(() => {
	if (hasUsers(database)) {
		redirect(303, '/login');
	}
	serverSetupCode.ensureIssued();
	return {};
});

export const actions = {
	default: page.public(async (event) => {
		const data = await event.request.formData();
		const values = {
			setupCode: formText(data, 'setupCode'),
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
		const result = await setupFirstAdmin(
			database,
			parsed.data,
			serverSetupCode,
			signInClient(event),
			Date.now()
		);
		if (result.kind === 'closed') {
			redirect(303, '/login');
		}
		if (result.kind === 'wrong-code') {
			return fail(400, {
				name: values.name,
				email: values.email,
				field: 'setupCode',
				message: result.message
			});
		}
		continueSignIn(event.cookies, result.next, '/');
	})
} satisfies Actions;
