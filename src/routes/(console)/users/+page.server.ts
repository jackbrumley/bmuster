import { database } from '#lib/server/database/app-database.ts';
import { page } from '#lib/server/guards/page.ts';
import { listUserGroups } from '#lib/server/services/access/groups.ts';
import { emailReadiness } from '#lib/server/services/settings/email-settings.ts';
import { listUsers } from '#lib/server/services/users/users.ts';
import type { PageServerLoad } from './$types';

/** Everyone who can sign in (SPEC-SIGN-IN S12) and their groups (SPEC-ACCESS A1); admins only. */
export const load: PageServerLoad = page.admin((_event, { user }) => ({
	now: Date.now(),
	me: user.id,
	users: listUsers(database),
	userGroups: listUserGroups(database),
	// Whether an invitation is emailed or handed to the admin as a link (SPEC-EMAIL E5).
	emailReady: emailReadiness(database).kind === 'ready'
}));
