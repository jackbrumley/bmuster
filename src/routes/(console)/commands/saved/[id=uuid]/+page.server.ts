import { error } from '@sveltejs/kit';
import { database } from '#lib/server/database/app-database.ts';
import { page } from '#lib/server/guards/page.ts';
import { SESSION_COOKIE } from '#lib/server/services/auth/sessions.ts';
import { savedFormData } from '#lib/server/services/commands/saved-command-admin.ts';
import { findSavedCommand } from '#lib/server/services/commands/saved-commands.ts';
import type { PageServerLoad } from './$types';

/** A saved command's form (SPEC-SAVED-COMMANDS SC2–SC7), admins only. */
export const load: PageServerLoad = page.admin(({ params, cookies }, { user }) => {
	const command = findSavedCommand(database, params.id);
	if (command === undefined) {
		error(404, 'No saved command with this id.');
	}
	return {
		command,
		...savedFormData(database, user.id, cookies.get(SESSION_COOKIE) ?? '', Date.now())
	};
});
