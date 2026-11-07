import { database } from '#lib/server/database/app-database.ts';
import { page } from '#lib/server/guards/page.ts';
import { listUsers } from '#lib/server/services/users/users.ts';
import type { PageServerLoad } from './$types';

/** Everyone who can sign in (SPEC-SIGN-IN S12); admins only. */
export const load: PageServerLoad = page.admin((_event, { user }) => ({
	now: Date.now(),
	me: user.id,
	users: listUsers(database)
}));
