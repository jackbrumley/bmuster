import { database } from '#lib/server/database/app-database.ts';
import { page } from '#lib/server/guards/page.ts';
import { SESSION_COOKIE } from '#lib/server/services/auth/sessions.ts';
import { savedFormData } from '#lib/server/services/commands/saved-command-admin.ts';
import type { PageServerLoad } from './$types';

/** New saved command (SPEC-SAVED-COMMANDS SC2–SC4), admins only. */
export const load: PageServerLoad = page.admin(({ cookies }, { user }) =>
	savedFormData(database, user.id, cookies.get(SESSION_COOKIE) ?? '', Date.now())
);
